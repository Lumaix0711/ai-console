#!/usr/bin/env node
// AI Console · 主服务
// 零 npm 依赖，全部用 Node 内置模块。
// 职责：静态文件 + REST + SSE 中转 + 上游 opencode serve 生命周期。
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig, expandPath, PUBLIC_DIR, ROOT } from './lib/paths.mjs'
import { createClient } from './lib/sse.mjs'
import { createStore, wire } from './lib/normalize.mjs'
import { writeSummary } from './lib/output.mjs'
import { resolveModels } from './lib/models.mjs'
import { closeDb, listSessions, getSession, getMessages, getSessionTree, getStats, listProjects } from './lib/db.mjs'
import { ensureIndex, search as fullTextSearch, indexStatus } from './lib/search.mjs'

const cfg = loadConfig()
const UI_PORT = Number(process.env.UI_PORT || 4090)
const UP = cfg.upstream

// ─────────────────────────────────────────────────────────────
// 上游 opencode serve：由本服务负责生命周期，退出时一并关掉
// ─────────────────────────────────────────────────────────────
let upstream = null
let upstreamLog = ''

function upstreamAlive() {
  return new Promise((res) => {
    const s = connect({ port: UP.port, host: UP.host })
    s.on('connect', () => { s.destroy(); res(true) })
    s.on('error', () => res(false))
  })
}

async function startUpstream() {
  if (await upstreamAlive()) {
    console.log(`  · 上游已在运行 :${UP.port}，直接复用`)
    return 'reused'
  }
  upstreamLog = ''
  // 必须用绝对路径：经由 wsl.exe 从 Windows 启动时，PATH 里没有
  // ~/.opencode/bin，用裸 'opencode' 会 ENOENT 直接崩掉。
  upstream = spawn(expandPath(UP.bin), [...UP.serveArgs, '--port', String(UP.port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  upstream.stdout.on('data', d => { upstreamLog += d })
  upstream.stderr.on('data', d => { upstreamLog += d })
  upstream.on('exit', (code) => {
    console.log(`  !上游进程退出 code=${code}`)
    upstream = null
    // 自动拉起
    setTimeout(() => { if (server.listening) startUpstream().catch(() => {}) }, 3000)
  })

  const end = Date.now() + 45000
  while (Date.now() < end) {
    if (await upstreamAlive()) return 'started'
    await sleep(400)
  }
  throw new Error(`上游 45 秒未就绪:\n${upstreamLog.slice(-800)}`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────
// 事件总线：SSE 客户端 → 浏览器
// ─────────────────────────────────────────────────────────────
const store = createStore()
const busClients = new Set()
const upstreamClient = createClient({ baseUrl: UP.baseUrl })

upstreamClient.on('event', (ev) => {
  store.apply(ev)
  onUpstreamEvent(ev)
  const payload = `data: ${JSON.stringify(ev)}\n\n`
  for (const res of busClients) {
    try { res.write(payload) } catch { busClients.delete(res) }
  }
})
upstreamClient.on('__open', () => console.log('  · SSE 已连接上游'))
upstreamClient.on('__close', (e) => console.log(`  · SSE 断开: ${e.error}，${e.backoff}ms 后重连`))

// ─────────────────────────────────────────────────────────────
// 静态文件：启动时读进内存（v9fs /mnt/c 上每次读盘都很慢）
// ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}
const staticCache = new Map()
function loadStatic() {
  staticCache.clear()
  if (!existsSync(PUBLIC_DIR)) return
  for (const f of ['index.html', 'app.css']) {
    const p = join(PUBLIC_DIR, f)
    if (!existsSync(p)) continue
    staticCache.set('/' + f, { body: readFileSync(p), type: MIME[extname(f)] || 'application/octet-stream' })
  }
  const idx = staticCache.get('/index.html')
  staticCache.set('/', idx ?? { body: Buffer.from('<h1>public/index.html 还没建</h1>'), type: MIME['.html'] })
}

// ─────────────────────────────────────────────────────────────
// REST
// ─────────────────────────────────────────────────────────────
const json = (res, obj, code = 200) => {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'content-type': MIME['.json'], 'content-length': b.length, 'cache-control': 'no-store' })
  res.end(b)
}

async function api(req, res, url) {
  const p = url.pathname

  if (p === '/api/health') {
    return json(res, {
      ok: true,
      upstream: { ...UP, alive: await upstreamAlive() },
      models: (await resolveModels({ baseUrl: UP.baseUrl })).allowed.map(m => ({
        id: m.id, tier: m.tier, tierLabel: m.tierLabel, context: m.context, reasoning: m.reasoning,
      })),
      modelWarning: (await resolveModels({ baseUrl: UP.baseUrl })).lowWarning,
      modelBlocked: (await resolveModels({ baseUrl: UP.baseUrl })).blocked
        .map((m) => ({ id: m.id, reason: m.reason })),
      modes: (await (await fetch(`${UP.baseUrl}/agent`)).json())
        .filter((a) => a.mode === 'primary' && ['build', 'plan'].includes(a.name))
        .map((a) => ({ name: a.name, description: a.description })),
    })
  }

  // 实时状态（自动分裂后的格子数据）
  if (p === '/api/state') return json(res, store.snapshot())

  // 某个会话的完整消息（含思考过程）
  if (p.startsWith('/api/session/')) {
    const id = decodeURIComponent(p.slice('/api/session/'.length))
    const live = store.detail(id)
    if (live) return json(res, live)
    try { return json(res, { id, fromDb: true, messages: getMessages(id) }) }
    catch (e) { return json(res, { error: e.message }, 404) }
  }

  // 历史
  if (p === '/api/sessions') {
    const limit = Number(url.searchParams.get('limit') || 50)
    const search = url.searchParams.get('q') || ''
    return json(res, listSessions({ limit, search }))
  }
  if (p === '/api/tree') return json(res, getSessionTree())
  if (p === '/api/stats') return json(res, getStats())
  if (p === '/api/projects') return json(res, listProjects())

  // MCP（只读）
  if (p === '/api/mcp') {
    const r = await fetch(`${UP.baseUrl}/mcp`)
    return json(res, await r.json())
  }

  // Skill（只读：只列目录 + 读 frontmatter）
  if (p === '/api/skills') {
    const rf = readFileSync
    const dir = cfg.paths.skillsDir
    if (!existsSync(dir)) return json(res, [])
    const out = []
    for (const name of readdirSync(dir)) {
      const f = join(dir, name, 'SKILL.md')
      if (!existsSync(f)) { out.push({ name, hasSkill: false }); continue }
      const txt = rf(f, 'utf8')
      const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const meta = {}
      if (fm) {
          const flines = fm[1].split(/\r?\n/)
        for (let i = 0; i < flines.length; i++) {
          const m = flines[i].match(/^([\w-]+):\s*(.*)$/)
          if (!m) continue
          let val = m[2]
          // YAML 块标量：description: | / > 的值在下面几行缩进里。
          // 只读第一行的话，humanizer-zh 的描述会变成 "|"。
          if (/^[|>][-+]?$/.test(val.trim())) {
            const ind = (flines[i + 1] || '').match(/^\s*/)[0].length
            const buf = []
            for (let j = i + 1; j < flines.length; j++) {
              const ind2 = (flines[j].match(/^\s*/) || [''])[0].length
              if (flines[j].trim() && ind2 < ind) break
              if (!flines[j].trim()) { if (buf.length) buf.push(''); continue }
              buf.push(flines[j].slice(ind))
              i = j
            }
            val = buf.join(' ').replace(/\s+/g, ' ').trim()
          } else {
            val = val.replace(/^["']|["']$/g, '')
          }
          meta[m[1]] = val
        }
      }
      out.push({
        name,
        hasSkill: true,
        description: meta.description ?? '',
        lines: txt.split('\n').length,
        bytes: statSync(f).size,
      })
    }
    return json(res, out)
  }

  // Agent（只读）
  if (p === '/api/agents') {
    const r = await fetch(`${UP.baseUrl}/agent`)
    return json(res, await r.json())
  }

  // 历史：会话列表（最近优先，不含子代理会话）
  // 跨会话全文搜索（FTS5 + CJK bigram）
  // ?q=关键词&limit=30&rebuild=1
  if (p === '/api/search') {
    const q = String(url.searchParams.get('q') || '')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 200)
    const rebuild = url.searchParams.get('rebuild') === '1'
    try {
      if (rebuild) ensureIndex({ force: true })
      const t0 = Date.now()
      const hits = fullTextSearch(q, { limit })
      const ms = Date.now() - t0
      // 片段里的 \u0001/\u0002 是命中标记，转成前端好用的 [start,end) 偏移，省得前端再解析
      const cleaned = hits.map((h) => {
        const a = h.snippet.indexOf('\u0001')
        const b = h.snippet.indexOf('\u0002')
        let text = h.snippet, mark = null
        if (a >= 0 && b > a) {
          mark = [a, b - a]
          text = h.snippet.replace('\u0001', '').replace('\u0002', '')
        }
        return {
          sessionID: h.session_id, messageID: h.message_id, partID: h.part_id,
          role: h.role, agent: h.agent, title: h.title, time: h.time_created,
          text, mark,
        }
      })
      return json(res, { query: q, hits: cleaned, ms, status: indexStatus() })
    } catch (e) {
      return json(res, { error: '搜索失败：' + e.message }, 500)
    }
  }

  if (p === '/api/history/list') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 60, 300)
    const q = String(url.searchParams.get('q') || '')
    const rows = listSessions({ limit, search: q })
    return json(res, { sessions: rows.map((r) => ({
      id: r.id, title: r.title, agent: r.agent, parentID: r.parent_id || null,
      directory: r.directory, messages: r.message_count,
      reasoning: r.reasoning_count, tools: r.tool_count,
      cost: r.cost ?? 0,
      time: { created: r.time_created, updated: r.time_updated },
    })) })
  }

  // 历史：单会话完整回放（含思考过程、工具调用与输出）
  if (p === '/api/history' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload = {}
    try { payload = JSON.parse(body || '{}') } catch {}
    const sid = String(payload.sessionID || '').trim()
    if (!sid) return json(res, { error: 'sessionID 不能为空' }, 400)
    const sess = getSession(sid)
    if (!sess) return json(res, { error: '会话不存在', sessionID: sid }, 404)
    // 库里没有 thinking 标志，统一按文本语言推断，让历史回放和实时模式的标签一致
    const langOf = (t) => {
      const s = String(t || '')
      if (s.length < 8) return null
      const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
      return cjk / s.length > 0.08 ? 'zh' : 'en'
    }
    // 补上 sessionID / messageID —— 前端"刷新回填"要把这份数据重放成
    // 和 SSE 同形状的事件，这两个字段缺了就没法挂到对应的会话和消息上。
    const messages = getMessages(sid, { includeSystem: false }).map((m) => ({
      ...m,
      sessionID: sid,
      parts: m.parts.map((pt) => ({
        ...pt,
        sessionID: sid,
        messageID: m.id,
        ...(pt.type === 'reasoning' ? { thinking: langOf(pt.text) === 'en' } : {}),
      })),
    }))
    return json(res, {
      session: { id: sess.id, title: sess.title, agent: sess.agent, parentID: sess.parent_id || null, time: { created: sess.time_created, updated: sess.time_updated } },
      messages,
    })
  }

  // 子代理模型选择（改写 ~/.config/opencode/agents/*.md 的 model 字段）
  // 不选 = 删掉 model 字段 = 子代理继承主会话模型（这才是"跟随主 AI"）
  // 改完必须让上游重读 agent，否则 opencode serve 用的是启动时的缓存。
  if (p === '/api/subagent-model') {
    if (req.method === 'GET') {
      return json(res, { current: readAgentModels() })
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let payload = {}
    try { payload = JSON.parse(body || '{}') } catch {}

    const mr = await resolveModels({ baseUrl: UP.baseUrl })
    const allow = new Set(mr.allowed.map((m) => m.id))
    const AGENTS = ['researcher', 'cross-checker', 'orchestrator']
    const pick = {}
    for (const a of AGENTS) {
      const v = String(payload[a] ?? '').trim()
      if (v && !allow.has(v)) return json(res, { error: `模型不在免费白名单内: ${v}` }, 400)
      pick[a] = v
    }

    const changed = []
    for (const a of AGENTS) {
      const f = join(homedir(), '.config', 'opencode', 'agents', `${a}.md`)
      if (!existsSync(f)) continue
      const before = readFileSync(f, 'utf8')
      const after = writeAgentModel(before, pick[a])
      if (after !== before) { writeFileSync(f, after); changed.push(a) }
    }

    // 触发上游重读 agent（实测有效，且不会杀掉已有会话）
    let reloaded = false, reloadErr = null
    try {
      const r = await fetch(`${UP.baseUrl}/global/dispose`, { method: 'POST' })
      reloaded = r.ok
      if (!r.ok) reloadErr = `上游返回 ${r.status}`
    } catch (e) { reloadErr = e.message }

    // 复核：以上游实际返回为准，不靠猜
    await sleep(1200)
    const actual = await readAgentModelsFromUpstream()

    return json(res, {
      ok: true, requested: pick, changed, reloaded, reloadErr,
      actual,
      note: changed.length === 0 ? '文件内容未变化' : `已改写 ${changed.length} 个 agent 定义`,
    })
  }

  // 术语卡片：用一次临时会话问一句，用完立刻删（零残留，不污染历史列表）
  if (p === '/api/explain' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload = {}
    try { payload = JSON.parse(body || '{}') } catch {}
    const term = String(payload.term || '').trim().slice(0, 80)
    const context = String(payload.context || '').trim().slice(0, 400)
    const followUp = String(payload.followUp || '').trim().slice(0, 200)
    if (!term) return json(res, { error: 'term 不能为空' }, 400)
    if (term.length > 80) return json(res, { error: 'term 太长' }, 400)

    let sid = null
    // 上游的 session.idle 是**异步**推过来的，而且比这个 HTTP 请求返回得晚：
    // 之前在 finally 里立刻 termSessions.delete(sid)，结果 idle 到达时登记早没了，
    // 守卫形同虚设（实测每次选词照样在 output/ 留一个 term-*.md）。
    // 所以这里只登记、不立刻注销，改由 onUpstreamEvent 命中时注销；
    // 万一 idle 永远不来（会话被提前删掉），60 秒后自动清掉防泄漏。
    const cleanup = () => {
      if (!sid) return
      fetch(`${UP.baseUrl}/session/${sid}`, { method: 'DELETE' }).catch(() => {})
      setTimeout(() => termSessions.delete(sid), 60_000).unref?.()
    }
    try {
      const mr = await resolveModels({ baseUrl: UP.baseUrl })
      // 解释术语用 tier1（zero-retention）模型优先，其次任何免费模型
      const pick = mr.allowed[0]
      if (!pick) return json(res, { error: '当前没有可用的免费模型' }, 503)

      const r = await fetch(`${UP.baseUrl}/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'term-' + term.slice(0, 20) }),
      })
      const sj = await r.json()
      sid = sj.id
      termSessions.add(sid)

      const question = followUp
        ? `关于「${term}」，我追问：${followUp}\n\n（这个词出现在这句话里：${context || '（无上下文）'}）`
        : `请用**两句话**解释「${term}」在这句话里的含义：\n\n「${context || term}」\n\n要求：先给结论，不要铺垫；如果这个词有多义，说清楚这里指哪一个；不要用「这个」「它」开头。`

      const r2 = await fetch(`${UP.baseUrl}/session/${sid}/message`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: { providerID: 'opencode', modelID: pick.id },
          agent: 'build',
          parts: [{ type: 'text', text: question }],
          system: '所有面向用户的输出必须使用简体中文。代码、命令、专有名词可保留原文。',
        }),
      })
      if (!r2.ok) throw new Error(`上游 HTTP ${r2.status}`)
      const ans = await r2.json()
      const answer = (ans.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim()
      if (!answer) throw new Error('上游没返回正文')
      return json(res, { ok: true, term, answer, model: pick.id })
    } catch (e) {
      return json(res, { error: '解释失败：' + e.message }, 502)
    } finally {
      cleanup()
    }
  }

  // 发消息（创建会话 + prompt_async）
  if (p === '/api/send' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { return json(res, { error: 'JSON 解析失败' }, 400) }
    const text = String(payload.text || '').trim()
    if (!text) return json(res, { error: 'text 不能为空' }, 400)

    const mr = await resolveModels({ baseUrl: UP.baseUrl, force: !!payload.refreshModels })
    // 模型必须属于当前解析出的免费白名单，防止前端传了付费或本地模型
    const modelID = payload.model && mr.allowed.some((m) => m.id === payload.model)
      ? payload.model
      : mr.allowed[0]?.id
    if (!modelID) return json(res, { error: '当前没有可用的免费模型' }, 503)

    // 模式：只允许 opencode 原生 primary agent（build / plan）
    let agent = payload.agent || 'build'
    try {
      const list = await (await fetch(`${UP.baseUrl}/agent`)).json()
      if (!list.some((a) => a.name === agent && a.mode === 'primary')) agent = 'build'
    } catch { agent = 'build' }

    let sid = payload.sessionID
    if (!sid) {
      const r = await fetch(`${UP.baseUrl}/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: text.slice(0, 40) }),
      })
      if (!r.ok) return json(res, { error: `建会话失败 HTTP ${r.status}` }, 502)
      sid = (await r.json()).id
    }

    // 中文约束走 system 字段，不污染用户原始输入
    const body2 = {
      model: { providerID: 'opencode', modelID },
      agent,
      parts: [{ type: 'text', text }],
    }
    if (payload.chinese !== false) {
      body2.system = [
        '所有面向用户的输出必须使用简体中文。代码、命令、专有名词可保留原文。',
        // 踩过的坑：AI 一旦去读 opencode.json，opencode 的 read/bash 工具会死锁，
        // tool 永远停在 running，整个会话不会再有思考和输出。已在 UI 加了卡住检测。
        '不要用 read 或 bash 去读 ~/.config/opencode/opencode.json（会触发工具死锁）。',
        '需要了解模型/Provider 配置时，优先调用可用的信息接口，不要直接读配置文件。',
      ].join('\n')
    }

    const r2 = await fetch(`${UP.baseUrl}/session/${sid}/prompt_async`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body2),
    })
    if (!r2.ok && r2.status !== 204) {
      return json(res, { error: `发消息失败 HTTP ${r2.status}`, detail: await r2.text() }, 502)
    }
    return json(res, { ok: true, sessionID: sid, model: modelID, agent })
  }

  if (p === '/api/abort' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    const { sessionID } = JSON.parse(body || '{}')
    if (!sessionID) return json(res, { error: '缺 sessionID' }, 400)
    await fetch(`${UP.baseUrl}/session/${sessionID}/abort`, { method: 'POST' }).catch(() => {})
    return json(res, { ok: true })
  }

  // 权限审批回复：透传上游（官方文档：POST /session/:id/permissions/:permissionID，
  // body {response}；文档另写有可选 remember，先只发 response，实测有出入再补）。
  if (p === '/api/permission/reply' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let pl
    try { pl = JSON.parse(body || '{}') } catch { return json(res, { error: 'JSON 解析失败' }, 400) }
    const { sessionID, permissionID, response } = pl
    if (!sessionID || !permissionID || !['once', 'always', 'reject'].includes(response)) {
      return json(res, { error: '参数不完整（需要 sessionID / permissionID / response ∈ once|always|reject）' }, 400)
    }
    try {
      const r = await fetch(`${UP.baseUrl}/session/${sessionID}/permissions/${permissionID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response }),
      })
      if (!r.ok) return json(res, { error: `上游 HTTP ${r.status}`, detail: await r.text().catch(() => '') }, 502)
      return json(res, { ok: true })
    } catch (e) {
      return json(res, { error: '上游请求失败：' + e.message }, 502)
    }
  }

  // 待审批列表：页面刷新后回填用（上游 1.19 实测有 GET /permission）
  if (p === '/api/permissions') {
    try {
      const r = await fetch(`${UP.baseUrl}/permission`)
      if (!r.ok) return json(res, { error: `上游 HTTP ${r.status}` }, 502)
      return json(res, { ok: true, list: await r.json() })
    } catch (e) {
      return json(res, { error: '拉取失败：' + e.message }, 502)
    }
  }

  // 会话待办：todo.updated 之外的补底（页面刷新/装载历史时回填）。
  // 上游 1.19 有 GET /session/:id/todo，返回 [{content,status,priority}]（实测无 id）。
  // 会话不在上游/没有待办时上游给 404 —— 属正常情况，返回 {ok:false} 让前端静默跳过。
  if (p === '/api/todo') {
    const sid = url.searchParams.get('sessionID')
    if (!sid) return json(res, { error: '缺 sessionID' }, 400)
    try {
      const r = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sid)}/todo`)
      if (!r.ok) return json(res, { ok: false, error: `上游 HTTP ${r.status}` })
      return json(res, { ok: true, todos: await r.json() })
    } catch (e) {
      return json(res, { ok: false, error: '拉取失败：' + e.message })
    }
  }

  // ── 会话回退 / 分叉 / 压缩（M16）─────────────────────
  // revert 不带 messageID 时：取最后一条「含正文的用户消息」往回退（跳过 compaction 合成消息）。
  // 上游实测：revert 会把 assistant 归一成前一条 user 消息；文件改动单向还原
  // （unrevert 只恢复消息，不会把文件改回去）。
  if (p === '/api/revert' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let pl
    try { pl = JSON.parse(body || '{}') } catch { return json(res, { error: 'JSON 解析失败' }, 400) }
    const { sessionID } = pl
    if (!sessionID) return json(res, { error: '缺 sessionID' }, 400)
    try {
      let mid = pl.messageID
      if (!mid) {
        const mr = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sessionID)}/message`)
        if (!mr.ok) return json(res, { error: `上游 HTTP ${mr.status}` }, 502)
        const raw = await mr.json()
        const list = Array.isArray(raw) ? raw : (raw.data || [])
        const pick = [...list].reverse().find((m) => {
          const i = m.info || m
          if (i.role !== 'user') return false
          return (m.parts || []).some((pt) => pt.type === 'text' && String(pt.text || '').trim())
        })
        if (!pick) return json(res, { error: '没有可回退的用户消息' }, 400)
        mid = (pick.info || pick).id
      }
      const r = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sessionID)}/revert`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID: mid }),
      })
      if (!r.ok) return json(res, { error: `上游 HTTP ${r.status}`, detail: await r.text().catch(() => '') }, 502)
      const sess = await r.json()
      return json(res, { ok: true, revert: sess.revert || null, messageID: mid })
    } catch (e) {
      return json(res, { error: '回退失败：' + e.message }, 502)
    }
  }

  if (p === '/api/unrevert' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let pl
    try { pl = JSON.parse(body || '{}') } catch { return json(res, { error: 'JSON 解析失败' }, 400) }
    const { sessionID } = pl
    if (!sessionID) return json(res, { error: '缺 sessionID' }, 400)
    try {
      const r = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sessionID)}/unrevert`, { method: 'POST' })
      if (!r.ok) return json(res, { error: `上游 HTTP ${r.status}` }, 502)
      const sess = await r.json()
      return json(res, { ok: true, revert: sess.revert || null })
    } catch (e) {
      return json(res, { error: '恢复失败：' + e.message }, 502)
    }
  }

  // fork 不带 messageID = 整个会话复制成新会话（实测：消息 id 全部换新，原会话不动）
  if (p === '/api/fork' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let pl
    try { pl = JSON.parse(body || '{}') } catch { return json(res, { error: 'JSON 解析失败' }, 400) }
    const { sessionID } = pl
    if (!sessionID) return json(res, { error: '缺 sessionID' }, 400)
    try {
      const init = { method: 'POST', headers: { 'content-type': 'application/json' } }
      if (pl.messageID) init.body = JSON.stringify({ messageID: pl.messageID })
      const r = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sessionID)}/fork`, init)
      if (!r.ok) return json(res, { error: `上游 HTTP ${r.status}`, detail: await r.text().catch(() => '') }, 502)
      const sess = await r.json()
      return json(res, { ok: true, session: { id: sess.id, title: sess.title || '', parentID: sess.parentID || null } })
    } catch (e) {
      return json(res, { error: '分叉失败：' + e.message }, 502)
    }
  }

  // summarize 用会话自己的模型（GET /session/:id 的 model.providerID/modelID），
  // 上游会往会话里追加一条 compaction 用户消息 + 一条摘要 assistant 消息。
  if (p === '/api/summarize' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    let pl
    try { pl = JSON.parse(body || '{}') } catch { return json(res, { error: 'JSON 解析失败' }, 400) }
    const { sessionID } = pl
    if (!sessionID) return json(res, { error: '缺 sessionID' }, 400)
    try {
      const sr = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sessionID)}`)
      if (!sr.ok) return json(res, { error: `上游 HTTP ${sr.status}` }, 502)
      const sess = await sr.json()
      const model = sess.model || {}
      // 注意：会话对象里的 model 是 {id, providerID}（不是 modelID），prompt 的请求体才叫 modelID
      const providerID = model.providerID
      const modelID = model.id || model.modelID
      if (!providerID || !modelID) return json(res, { error: '会话没有可用模型' }, 400)
      const r = await fetch(`${UP.baseUrl}/session/${encodeURIComponent(sessionID)}/summarize`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerID, modelID }),
      })
      if (!r.ok) return json(res, { error: `上游 HTTP ${r.status}`, detail: await r.text().catch(() => '') }, 502)
      return json(res, { ok: true })
    } catch (e) {
      return json(res, { error: '压缩失败：' + e.message }, 502)
    }
  }

  // ── 截图管理（第一个 DaisyUI 灰度块）──────────────────
  // 读 ~/ai-console/screenshots/，按日期分组返回张数与大小。
  const SHOTS_DIR = join(ROOT, 'screenshots')
  const shotStat = () => {
    if (!existsSync(SHOTS_DIR)) return { dir: SHOTS_DIR, exists: false, totalBytes: 0, totalCount: 0, byDate: [] }
    const byDate = []
    let totalBytes = 0, totalCount = 0
    for (const day of readdirSync(SHOTS_DIR)) {
      const dd = join(SHOTS_DIR, day)
      try {
        if (!statSync(dd).isDirectory()) continue
        const pngs = readdirSync(dd).filter((f) => f.toLowerCase().endsWith('.png'))
        const bytes = pngs.reduce((n, f) => n + statSync(join(dd, f)).size, 0)
        if (pngs.length) { byDate.push({ day, count: pngs.length, bytes }); totalBytes += bytes; totalCount += pngs.length }
      } catch {}
    }
    byDate.sort((a, b) => b.day.localeCompare(a.day))
    return { dir: SHOTS_DIR, exists: true, totalBytes, totalCount, byDate }
  }

  if (p === '/api/screenshots') return json(res, shotStat())

  // 用资源管理器打开截图目录（Windows 侧 explorer.exe 开 UNC 路径）
  if (p === '/api/screenshots/open' && req.method === 'POST') {
    // 不写死用户名/家目录：发行版名取自 WSL 环境，路径从项目根推导。
    const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu-24.04'
    const rootWin = `\\\\wsl.localhost\\${distro}${ROOT.replace(/\//g, '\\')}`
    const unc = rootWin + '\\screenshots'
    // WSL 的 PATH 里没有 explorer.exe，必须用全路径，否则 spawn ENOENT。
    // 而且错误只在异步的 'error' 事件里出 —— 同步 try/catch 抓不到，
    // 得先监听 error，不能还没听就 unref 返回 ok。
    // 不只是打开，还要置顶。SetForegroundWindow 从后台进程调会被 Windows 拒绝，
    // 用 SetWindowPos(TOPMOST→NOTOPMOST) 才能真正抬上来 —— 脚本在 tools/ 里。
    const PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    const SCRIPT = rootWin + '\\tools\\open-shots-front.ps1'
    try {
      const ps = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, unc],
        { detached: true, stdio: 'ignore' })
      ps.on('error', (e) => console.log('  · 打开资源管理器失败: ' + e.message))
      ps.unref()
      return json(res, { ok: true, path: unc })
    } catch (e) {
      return json(res, { error: '无法打开资源管理器: ' + e.message }, 500)
    }
  }

  // 清空截图：只删 .png，保留日期目录结构，返回释放的空间。
  // 前端必须二次确认才调到这里。
  if (p === '/api/screenshots/clear' && req.method === 'POST') {
    if (!existsSync(SHOTS_DIR)) return json(res, { deleted: 0, freedBytes: 0 })
    let deleted = 0, freedBytes = 0
    for (const day of readdirSync(SHOTS_DIR)) {
      const dd = join(SHOTS_DIR, day)
      try {
        if (!statSync(dd).isDirectory()) continue
        for (const f of readdirSync(dd)) {
          if (!f.toLowerCase().endsWith('.png')) continue
          const full = join(dd, f)
          const sz = statSync(full).size
          freedBytes += sz
          rmSync(full, { force: true })
          deleted++
        }
      } catch {}
    }
    return json(res, { deleted, freedBytes, dir: SHOTS_DIR })
  }

  // 汇总：把 output/ 下的结果收集起来
  if (p === '/api/output') {
    const dir = cfg.paths.outputDir
    if (!existsSync(dir)) return json(res, { dir, files: [] })
    const files = readdirSync(dir).filter(f => !f.startsWith('.')).map(f => {
      const st = statSync(join(dir, f))
      return { name: f, bytes: st.size, mtime: st.mtimeMs }
    }).sort((a, b) => b.mtime - a.mtime)
    return json(res, { dir, files })
  }

  return json(res, { error: '未知接口', path: p }, 404)
}


// ── 子代理模型：读/改 ~/.config/opencode/agents/*.md 的 frontmatter model 字段 ──
const AGENT_NAMES = ['researcher', 'cross-checker', 'orchestrator']
const agentFile = (name) => join(homedir(), '.config', 'opencode', 'agents', `${name}.md`)

function readAgentModels() {
  const out = {}
  for (const a of AGENT_NAMES) {
    const f = agentFile(a)
    if (!existsSync(f)) { out[a] = null; continue }
    const m = readFileSync(f, 'utf8').match(/^model:\s*\S+\s*$/m)
    out[a] = m ? m[0].replace(/^model:\s*/, '').replace(/^opencode\//, '').trim() : ''
  }
  return out
}
async function readAgentModelsFromUpstream() {
  try {
    const d = await (await fetch(`${UP.baseUrl}/agent`)).json()
    const out = {}
    for (const a of AGENT_NAMES) {
      const hit = d.find((x) => x.name === a)
      out[a] = hit?.model?.modelID ?? ''
    }
    return out
  } catch { return {} }
}

/** 空字符串 = 删掉 model 字段，让子代理继承主会话模型 */
function writeAgentModel(src, modelID) {
  const line = modelID ? `model: opencode/${modelID}\n` : ''
  const re = /^model:\s*\S+\s*$\n?/m
  if (!re.test(src)) {
    if (!line) return src                       // 本来就没有，也不用加
    // 插到 frontmatter 里（第一段 --- 之后）
    const end = src.indexOf('\n---', 3)
    if (end < 0) return src
    return src.slice(0, end + 1) + line + src.slice(end + 1)
  }
  return src.replace(re, line)
}


// ── 汇总落盘：主会话 idle 时把最终答案写进 output/ ──
// 术语解释用的临时会话 id 登记在这里，落盘时跳过（见 onUpstreamEvent）。
const termSessions = new Set()

function onUpstreamEvent(ev) {
  // session.idle 是"这一轮跑完了"的信号。用 idle 而不是 step-finish，
  // 因为 idle 保证后面不会再有正文增量，适合作为落盘时点。
  if (ev.type !== 'session.idle') return
  const sid = ev.properties?.sessionID
  if (!sid) return
  // 术语卡片的临时会话（标题 term-xxx）只是"问一句就删"的中间产物，
  // 不该出现在用户的汇总夹里 —— 之前每次选词都在 output/ 留一个 term-*.md。
  if (termSessions.has(sid)) { termSessions.delete(sid); return }
  try {
    const r = writeSummary({
      outputDir: cfg.paths.outputDir,
      sessionID: sid,
      onSaved: ({ file, bytes }) => {
        // 通知页面：弹提示 + 点一下能打开目录
        const payload = JSON.stringify({ type: 'console.output', properties: { file, bytes, dir: cfg.paths.outputDir } })
        for (const res of busClients) { try { res.write(`data: ${payload}\n\n`) } catch { busClients.delete(res) } }
      },
    })
    if (r) console.log(`  · 汇总已保存: ${r.file} (${r.bytes}B)`)
  } catch (e) {
    console.log(`  · 汇总落盘失败（不影响使用）: ${e.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  try {
    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      busClients.add(res)
      const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(ka); busClients.delete(res) })
      return
    }

    if (url.pathname.startsWith('/api/')) return await api(req, res, url)

    // 静态
    let f = url.pathname === '/' ? '/' : url.pathname
    if (f.includes('..')) { res.writeHead(400); return res.end('bad path') }
    const hit = staticCache.get(f) ?? staticCache.get('/')
    res.writeHead(200, { 'content-type': hit.type, 'content-length': hit.body.length, 'cache-control': 'no-store' })
    return res.end(hit.body)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('500 ' + e.message)
  }
})

// ─────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════╗')
console.log('║   AI Console                                          ║')
console.log('╚══════════════════════════════════════════════════════╝')
console.log(`  项目根: ${ROOT}`)
console.log(`  界面端口: ${UI_PORT}   上游: ${UP.baseUrl}\n`)

try {
  const how = await startUpstream()
  console.log(`  ✅ 上游 opencode ${how === 'started' ? '已拉起' : '复用现有'} :${UP.port}`)
} catch (e) {
  console.error('  ❌ 上游启动失败:', e.message)
  process.exit(1)
}

upstreamClient.connect()
loadStatic()

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log(`  ✅ AI Console 就绪 →  http://localhost:${UI_PORT}\n`)
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// PID 文件：让"停止服务"这条命令可靠。
// 之前用 pkill -f "ai-console/server.mjs" 是错的——进程命令行是
// `node server.mjs`（相对路径），模式匹配不到。
const PID_FILE = join(ROOT, '.aiconsole.pid')

async function shutdown() {
  console.log('\n正在关闭…')
  upstreamClient.close()
  for (const r of busClients) { try { r.end() } catch {} }
  server.close()
  closeDb()
  try { unlinkSync(PID_FILE) } catch {}
  if (upstream) { try { process.kill(-upstream.pid) } catch {} }
  setTimeout(() => process.exit(0), 300)
}

// 清理上次异常退出留下的陈旧 PID 文件
if (existsSync(PID_FILE)) {
  const old = Number(readFileSync(PID_FILE, 'utf8').trim())
  if (old && old !== process.pid) {
    try { process.kill(old, 0) } catch { try { unlinkSync(PID_FILE) } catch {} }
  }
}
writeFileSync(PID_FILE, String(process.pid))
console.log(`  PID 文件: ${PID_FILE}`)