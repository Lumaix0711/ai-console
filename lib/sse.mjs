// opencode SSE 客户端
//
// 【M0 实测出来的硬规则，M4 必须遵守】
//  1. 思考文本不走 message.part.updated，走 message.part.delta
//     message.part.updated 只有两个态：创建时 text:""，完成时完整文本
//     → 骨架用 updated，内容用 delta 按 partID 累加
//  2. 消息结束只能看 message.updated 里 info.time.completed
//     绝不能用"text 长度 > 0"当完成标志—— reasoning 和 text 交错到达，
//     早断会丢掉全部思考过程（M0 踩了三次才定位）
//  3. 断线必须重连，重连后状态可能对不上，要让上层能从 /session 重新对账
import { loadConfig } from './paths.mjs'

export function createClient({ baseUrl } = {}) {
  const cfg = loadConfig()
  const url = `${baseUrl || cfg.upstream.baseUrl}/event`

  let ac = null
  let timer = null
  let backoff = cfg.sse.reconnectMinMs
  let closed = false
  let connected = false

  const handlers = new Map()
  const on = (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, new Set())
    handlers.get(type).add(fn)
    return () => handlers.get(type)?.delete(fn)
  }
  const emit = (type, payload) => {
    for (const fn of handlers.get(type) ?? []) { try { fn(payload) } catch {} }
    for (const fn of handlers.get('*') ?? []) { try { fn({ type, ...payload }) } catch {} }
  }

  async function connect() {
    if (closed) return
    try { ac?.abort() } catch {}
    ac = new AbortController()

    try {
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''

      connected = true
      backoff = cfg.sse.reconnectMinMs
      emit('__open', { url })

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        // SSE 用 \n 分隔帧；保留最后半行等下一批
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          let ev
          try { ev = JSON.parse(raw) } catch { continue }   // 半包，丢掉
          emit(ev.type, ev.properties ?? {})
          emit('event', ev)
        }
      }
      throw new Error('流被关闭')
    } catch (err) {
      if (closed || ac.signal.aborted) return
      connected = false
      emit('__close', { error: err.message, backoff })
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, cfg.sse.reconnectMaxMs)
  }

  return {
    on, emit, connect,
    get connected() { return connected },
    close() { closed = true; clearTimeout(timer); try { ac?.abort() } catch {} },
  }
}