// 事件 → UI 状态。纯内存，不碰 IO，方便 M1 直接在命令行验证。
//
// M4「自动分裂」的实现依据：任何带 parentID 的新 session 都自动开一格。
// 也就是说格子数量由主 AI 真实派活数决定，不是代码写死的。
import { createClient } from './sse.mjs'

export function createStore() {
  /** @type {Map<string, any>} */
  const sessions = new Map()
  const order = []          // 按出现顺序，UI 排版用
  const log = []            // 原始事件轨迹，调试用
  let eventCount = 0
  const unknown = new Map() // 没处理过的事件类型 → 次数

  function touch(sid) {
    if (!sessions.has(sid)) {
      sessions.set(sid, newSession(sid))
      order.push(sid)
    }
    const s = sessions.get(sid)
    // M17：任何事件都算该会话的活跃信号（时间线 + context 健康度用）
    s.lastEventAt = Date.now()
    return s
  }

  function newSession(id) {
    return {
      id,
      parentID: null,
      title: '',
      directory: null,
      agent: null,
      status: 'idle',        // idle | busy | retry | error | waiting
      error: null,
      statusNote: null,
      messages: new Map(),   // messageID -> msg
      lastText: '',
      lastReasoning: '',
      updatedAt: Date.now(),
      createdAt: null,       // 上游 session.time.created（毫秒）
      lastEventAt: Date.now(),
      model: null,           // {id, providerID} 归一化后的当前模型
      toolIds: new Set(),    // 工具 part 去重计数（M17 时间线）
      isNew: true,
    }
  }

  function message(sid, mid) {
    const s = touch(sid)
    if (!s.messages.has(mid)) {
      s.messages.set(mid, {
        id: mid, role: 'assistant', agent: null, model: null, provider: null,
        cost: 0, tokens: null, completed: false, parts: new Map(),
      })
    }
    return s.messages.get(mid)
  }

  function part(msg, id) {
    if (!msg.parts.has(id)) msg.parts.set(id, { id, type: 'unknown', text: '', tool: null, state: null })
    return msg.parts.get(id)
  }

  const api = {
    sessions, order, log, unknown,
    get eventCount() { return eventCount },

    apply(ev) {
      const type = ev.type
      const pr = ev.properties ?? {}
      eventCount++
      if (log.length < 400) log.push({ t: Date.now(), type, keys: Object.keys(pr) })
      if (!api.__known.has(type)) unknown.set(type, (unknown.get(type) || 0) + 1)

      switch (type) {
        // ── 会话生命周期 ────────────────────────────────
        case 'session.created': {
          const info = pr.info ?? {}
          const s = touch(info.id)
          Object.assign(s, {
            parentID: info.parentID ?? null,
            title: info.title ?? '',
            directory: info.directory ?? null,
            revert: info.revert ?? null,
            createdAt: info.time?.created ?? s.createdAt ?? Date.now(),
            model: normModel(info.model) ?? s.model,
          })
          break
        }
        case 'session.updated': {
          const info = pr.info ?? {}
          if (!info.id) break
          const s = touch(info.id)
          s.parentID = info.parentID ?? s.parentID
          s.title = info.title ?? s.title
          s.directory = info.directory ?? s.directory
          s.agent = info.agent ?? s.agent
          // 实测 session.updated 每次都带完整会话对象（title/model/tokens 全在）；
          // unrevert 后是"整个 revert 键消失"而不是 null —— 所以必须按全量信任。
          s.revert = info.revert ?? null
          s.createdAt = info.time?.created ?? s.createdAt
          s.model = normModel(info.model) ?? s.model
          break
        }
        // M4 的分裂触发点就在这里：带 parentID 的新 session
        case 'session.status': {
          const s = touch(pr.sessionID)
          const st = pr.status ?? {}
          if (st.type === 'busy') { s.status = 'busy'; s.statusNote = null }
          else if (st.type === 'idle') { s.status = 'idle'; s.statusNote = null }
          else if (st.type === 'retry') { s.status = 'retry'; s.statusNote = st.message }
          break
        }
        case 'session.idle': {
          const s = touch(pr.sessionID)
          s.status = 'idle'
          break
        }
        case 'session.error': {
          const s = touch(pr.sessionID)
          s.status = 'error'
          s.error = pr.error?.data?.message ?? pr.error?.name ?? '未知错误'
          break
        }
        case 'permission.updated': {
          const sid = pr.sessionID
          if (sid) { const s = touch(sid); s.status = 'waiting'; s.statusNote = pr.title ?? pr.type ?? '等待授权' }
          break
        }
        case 'permission.replied': {
          const sid = pr.sessionID
          if (sid) { const s = touch(sid); if (s.status === 'waiting') s.status = 'busy' }
          break
        }

        // ── 消息 ────────────────────────────────────────
        case 'message.updated': {
          const info = pr.info
          if (!info?.sessionID || !info?.id) break
          const m = message(info.sessionID, info.id)
          m.role = info.role ?? m.role
          m.agent = info.agent ?? m.agent
          m.model = info.modelID ?? m.model
          m.provider = info.providerID ?? m.provider
          m.cost = info.cost ?? m.cost
          m.tokens = info.tokens ?? m.tokens
          // 【关键】完成判定只看这里，绝不用 text 长度
          m.completed = !!info.time?.completed
          touch(info.sessionID).updatedAt = Date.now()
          break
        }
        case 'message.removed': {
          sessions.get(pr.sessionID)?.messages.delete(pr.messageID)
          break
        }

        // ── part：updated 建骨架 ────────────────────────
        case 'message.part.updated': {
          const p = pr.part
          if (!p?.messageID) break
          const m = message(p.sessionID, p.messageID)
          const rec = part(m, p.id)
          rec.type = p.type
          if (typeof p.text === 'string' && p.text.length >= rec.text.length) rec.text = p.text
          if (p.time) rec.time = p.time
          if (p.tool) rec.tool = p.tool
          if (p.state) rec.state = p.state
          if (p.agent) rec.agent = p.agent
          if (p.description) rec.description = p.description
          if (p.type === 'tool' && p.id) touch(p.sessionID).toolIds.add(p.id)
          if (p.type === 'text') api.__lastText(p.sessionID, p.text)
          if (p.type === 'reasoning') api.__lastReasoning(p.sessionID, p.text)
          break
        }

        // ── part：delta 填内容（M0 定位到的真正数据通道）──
        case 'message.part.delta': {
          const { sessionID, messageID, partID, field, delta } = pr
          if (!messageID || !partID) break
          const m = message(sessionID, messageID)
          const rec = part(m, partID)
          if (field === 'text' && typeof delta === 'string') {
            rec.text += delta
            if (rec.type === 'text') api.__lastText(sessionID, rec.text)
            if (rec.type === 'reasoning') api.__lastReasoning(sessionID, rec.text)
          }
          break
        }

        case 'message.part.removed': {
          // 从 e2去掉
          break
        }
        default:
          break
      }
      return api
    },

    __lastText(sid, t) { const s = sessions.get(sid); if (s) s.lastText = t },
    __lastReasoning(sid, t) { const s = sessions.get(sid); if (s) s.lastReasoning = t },

    /** 实时快照，给 UI 渲染 */
    snapshot() {
      const list = order.map(id => sessions.get(id)).filter(Boolean)
      return {
        eventCount,
        sessions: list.map(s => ({
          id: s.id,
          parentID: s.parentID,
          revert: s.revert ?? null,
          title: s.title,
          status: s.status,
          statusNote: s.statusNote,
          error: s.error,
          agent: s.agent,
          directory: s.directory,
          messageCount: s.messages.size,
          reasoningChars: s.lastReasoning.length,
          textChars: s.lastText.length,
          cost: [...s.messages.values()].reduce((n, m) => n + (m.cost || 0), 0),
          reasoningTokens: [...s.messages.values()].reduce((n, m) => n + (m.tokens?.reasoning ?? 0), 0),
          completed: [...s.messages.values()].filter(m => m.completed).length,
          createdAt: s.createdAt,
          lastEventAt: s.lastEventAt,
          model: s.model,
          toolCount: s.toolIds.size,
          ctxTokens: ctxTokensOf(s),
        })),
        roots: list.filter(s => !s.parentID).map(s => s.id),
        children: list.filter(s => s.parentID).map(s => ({ id: s.id, parentID: s.parentID })),
      }
    },

    /** 某个会话的完整消息（含思考过程） */
    detail(sessionId) {
      const s = sessions.get(sessionId)
      if (!s) return null
      return {
        id: s.id, title: s.title, status: s.status,
        messages: [...s.messages.values()].map(m => ({
          id: m.id, role: m.role, agent: m.agent, model: m.model,
          cost: m.cost, tokens: m.tokens, completed: m.completed,
          parts: [...m.parts.values()],
        })),
      }
    },
  }

  api.__known = new Set([
    'session.created', 'session.updated', 'session.status', 'session.idle',
    'session.error', 'permission.updated', 'permission.replied',
    'message.updated', 'message.removed',
    'message.part.updated', 'message.part.delta', 'message.part.removed',
  ])

  return api
}

/** 把 store 接到 SSE 上 */
// assistant 消息的 tokens 是"这一轮调用"的账本：total 已含 input + 缓存 + output + reasoning。
// 上下文占用 = total - output - reasoning（即提示词那侧），最后一个非零的 assistant 消息就是当前水位。
function ctxTokensOf(s) {
  let ctx = 0
  for (const m of s.messages.values()) {
    const t = m.tokens
    if (!t) continue
    const total = Number(t.total) || 0
    if (!total) continue
    ctx = Math.max(0, total - (Number(t.output) || 0) - (Number(t.reasoning) || 0))
  }
  return ctx || null
}

// SSE 的 session.model 两种形状并存过：{id, providerID} 和 {modelID, providerID}
function normModel(m) {
  if (!m) return null
  const id = typeof m === 'string' ? m : (m.id || m.modelID)
  if (!id) return null
  return { id, providerID: m.providerID ?? null }
}

export function wire(store, client) {
  client.on('event', (ev) => store.apply(ev))
  return client
}