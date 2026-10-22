#!/usr/bin/env node
// M0 · 可行性探针
// 目的：在写任何 UI 之前，一次性验证三个可能推翻整个方案的风险点。
// 用法：node M0-probe.mjs
// 退出码：0 = 三项全 PASS；1 = 有 FAIL（看输出里的退路建议）

const OPENCODE_BIN = process.env.OPENCODE_BIN ||
  (process.env.HOME + '/.opencode/bin/opencode')
import { spawn, execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PORT = Number(process.env.PROBE_PORT || 4096)
const HOST = process.env.PROBE_HOST || '127.0.0.1'
const BASE = `http://127.0.0.1:${PORT}`
const WIN_CURL = '/mnt/c/Windows/System32/curl.exe'

const results = []
const log = (...a) => console.log(...a)
const ok = (id, msg) => { results.push({ id, pass: true }); log(`  [PASS] ${id}  ${msg}`) }
const bad = (id, msg, fallback) => { results.push({ id, pass: false }); log(`  [FAIL] ${id}  ${msg}`); if (fallback) log(`         退路: ${fallback}`) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────
async function waitForPort(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const up = await new Promise((res) => {
      const s = createConnection({ port, host: '127.0.0.1' })
      s.on('connect', () => { s.destroy(); res(true) })
      s.on('error', () => res(false))
    })
    if (up) return true
    await sleep(500)
  }
  return false
}

// ── 0-a  Windows 侧能否访问 WSL 里的 localhost 服务 ──────────────
function testWindowsReach() {
  return new Promise((resolve) => {
    // 用 Windows 自带的 curl.exe 去请求 WSL 里的服务。
    // 如果它能拿到 JSON，就证明 mirrored 网络模式生效（Windows 和 WSL 共享 localhost）。
    execFile(WIN_CURL, ['-s', '--max-time', '8', `${BASE}/global/health`],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim()
        if (!err && out.includes('healthy')) {
          resolve({ pass: true, detail: out.slice(0, 120) })
        } else {
          resolve({ pass: false, detail: (stderr || err?.message || '无响应').slice(0, 160) })
        }
      })
  })
}

// ── 0-b  免费模型能否通过 SSE 返回 reasoning part ────────────────
async function testReasoning() {
  const freeCandidates = ['space-bunny-free', 'longcat-2.5-preview-free']

  // SSE 必须在开始读之后立刻接上，且全程保持读取。
  // （早先版本把连接提前十几秒才读，ReadableStream 背压导致 delta 事件全丢。）
  const sse = await fetch(`${BASE}/event`, { headers: { accept: 'text/event-stream' } })
  if (!sse.ok || !sse.body) return { pass: false, detail: `SSE 连接失败 HTTP ${sse.status}` }
  const stream = sse.body

  const seen = { events: 0, types: new Set(), errors: [] }

  // 在后台读 SSE
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ''
  // partID -> { type, text }。message.part.updated 建骨架，message.part.delta 填内容。
  // 关键：思考文本只在 delta 里流式传输，只听 updated 会拿到 text:"" 的空壳。
  const parts = new Map()
  let deltas = 0

  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const ev = JSON.parse(line.slice(5).trim())
            seen.events++
            if (ev.type) seen.types.add(ev.type)
            const pr = ev.properties

            if (ev.type === 'message.part.updated' && pr?.part) {
              const p = pr.part
              seen.types.add('part:' + p.type)
              const rec = parts.get(p.id) || { type: p.type, text: '' }
              rec.type = p.type
              if (typeof p.text === 'string' && p.text.length >= rec.text.length) rec.text = p.text
              parts.set(p.id, rec)
            } else if (ev.type === 'message.part.delta' && pr?.partID) {
              deltas++
              const rec = parts.get(pr.partID) || { type: 'unknown', text: '' }
              if (pr.field === 'text') rec.text += pr.delta || ''
              parts.set(pr.partID, rec)
            } else if (ev.type === 'session.error') {
              seen.errors.push(JSON.stringify(pr).slice(0, 200))
            }
          } catch { /* 半包，忽略 */ }
        }
      }
    } catch { /* 流结束 */ }
  })()

  // 逐个尝试候选模型（每个模型用全新会话，避免状态串味）
  for (const model of freeCandidates) {
    log(`  … 尝试模型 opencode/${model}`)
    const sres = await fetch(`${BASE}/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'M0-probe ' + model }),
    })
    if (!sres.ok) { log(`     建会话失败 HTTP ${sres.status}`); continue }
    const sid = (await sres.json()).id

    parts.clear(); deltas = 0
    seen.events = 0; seen.types.clear(); seen.errors = []

    const pres = await fetch(`${BASE}/session/${sid}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: 'opencode', modelID: model },
        // 必须用需要推理的题：简单算术模型会直接答，不产生 reasoning
        parts: [{ type: 'text', text: '三个箱子标签写着"苹果""橘子""混合"，三个标签全都贴错了。只能从一个箱子摸出一个水果。最少摸几次就能确定三个箱子各装什么？请详细推理。' }],
      }),
    })
    if (!pres.ok && pres.status !== 204) {
      log(`     发送失败 HTTP ${pres.status}`)
      continue
    }

    // 等 assistant 消息 time.completed —— 不能一见 text 就break，
    // 否则会在 reasoning 到达前就掐断（实测踩过这个坑）。
    let completed = false
    for (let i = 0; i < 120; i++) {
      await sleep(1000)
      try {
        const msgs = await (await fetch(`${BASE}/session/${sid}/message`)).json()
        const a = msgs.filter(m => m.info?.role === 'assistant')
        if (a.length && a[a.length - 1].info?.time?.completed) { completed = true; break }
      } catch { /* 忽略 */ }
      if (seen.errors.length) break
    }
    await sleep(2000)   // 等最后的 delta 落地
    log(`     完成状态: ${completed ? 'completed' : '超时'}｜全部事件类型: ${[...seen.types].join(' ')}`)

    if (seen.errors.length) {
      log(`     ✗ 模型报错: ${seen.errors[0]}`)
      await fetch(`${BASE}/session/${sid}/abort`, { method: 'POST' }).catch(() => {})
      continue
    }

    const all = [...parts.values()]
    const reasoning = all.filter(p => p.type === 'reasoning')
    const texts = all.filter(p => p.type === 'text')
    const rChars = reasoning.reduce((n, p) => n + p.text.length, 0)
    const tChars = texts.reduce((n, p) => n + p.text.length, 0)

    await fetch(`${BASE}/session/${sid}/abort`, { method: 'POST' }).catch(() => {})

    if (texts.length > 0) {
      const detail = `${model}｜${seen.events} 事件（delta ${deltas}）｜` +
        `reasoning ${reasoning.length} 段/${rChars} 字｜text ${texts.length} 段/${tChars} 字`
      const dist = [...seen.types].filter(t => t.startsWith('part:') || t.startsWith('message')).join(' ')
      log(`     事件类型: ${dist}`)
      if (reasoning.length > 0 && rChars > 0) {
        try { await reader.cancel() } catch {}
        return { pass: true, detail: detail + '  ← 思考过程实时可用' }
      }
      try { await reader.cancel() } catch {}
      return { pass: false, detail: detail + '  ← 有输出但无 reasoning', fallback: '思考面板改显示 step/tool 时间线' }
    }
  }

  try { await reader.cancel() } catch {}
  return { pass: false, detail: '所有候选免费模型都没返回输出', fallback: '检查 Zen 凭据 / 模型是否已到期' }
}

// ── 0-c  opencode.db 能否只读拿到 session→message→part ───────────
function testDb() {
  const home = process.env.HOME
  const dbPath = join(home, '.local/share/opencode/opencode.db')
  const work = mkdtempSync(join(tmpdir(), 'aiconsole-probe-'))
  let db
  try {
    // 先把 db + wal + shm 复制到临时目录再只读打开：
    // 直接开原库会共享 WAL 锁，而且原库正在被别的 opencode 进程写。
    copyFileSync(dbPath, join(work, 'opencode.db'))
    if (existsSync(dbPath + '-wal')) copyFileSync(dbPath + '-wal', join(work, 'opencode.db-wal'))
    if (existsSync(dbPath + '-shm')) copyFileSync(dbPath + '-shm', join(work, 'opencode.db-shm'))

    db = new DatabaseSync(join(work, 'opencode.db'), { readOnly: true })

    const q = (sql) => db.prepare(sql).all()
    const one = (sql) => db.prepare(sql).get()

    const sessions = one('select count(*) c from session')?.c ?? 0
    const messages = one('select count(*) c from message')?.c ?? 0
    const parts = one('select count(*) c from part')?.c ?? 0

    // 真实表结构：message/part 没有 role/type 列，都藏在 data JSON 里。
    // session 的 parent_id / directory / cost / tokens_* 是独立列。
    const typeDist = q(`
      select json_extract(data,'$.type') t, count(*) n
      from part group by t order by n desc
    `)
    const reasoningCount = one(`select count(*) c from part where json_extract(data,'$.type')='reasoning'`)?.c ?? 0

    // 关键验证：三表关联能不能真的取到带思考过程的对话
    const sample = q(`
      select s.title stitle, s.directory sdir,
             json_extract(m.data,'$.role') role,
             substr(json_extract(p.data,'$.text'),1,70) ptext
      from session s
      join message m on m.session_id = s.id
      join part   p on p.message_id = m.id
      where json_extract(p.data,'$.type') = 'reasoning'
      order by s.time_created desc
      limit 3
    `)

    const tokenTotals = one(`
      select sum(tokens_input) ti, sum(tokens_output) to_, sum(tokens_reasoning) tr, round(sum(cost),4) c
      from session
    `)

    // 父子树（子代理会话）
    const withParent = q(`select id, parent_id, title, agent from session where parent_id is not null limit 3`)
    const parentTotal = one('select count(*) c from session where parent_id is not null')?.c ?? 0

    return {
      pass: sessions > 0 && messages > 0 && parts > 0 && reasoningCount > 0,
      sessions, messages, parts, reasoningCount, typeDist, sample, tokenTotals,
      withParent, parentTotal,
      note: 'db 拷贝后只读打开，不碰原库',
    }
  } catch (e) {
    return { pass: false, detail: e.message }
  } finally {
    try { db?.close() } catch {}
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }
}

// ─────────────────────────────────────────────────────────────
log('\n╔══════════════════════════════════════════════════════╗')
log('║   AI Console · M0 可行性探针                          ║')
log('╚══════════════════════════════════════════════════════╝\n')

// 1) 拉起一个 opencode serve
log('【准备】拉起 opencode serve …')
const server = spawn(OPENCODE_BIN, ['serve', '--port', String(PORT), '--hostname', HOST], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let serverLog = ''
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })

if (!await waitForPort(PORT)) {
  bad('0-bootstrap', `opencode serve 40 秒内没起来`, `看日志:\n${serverLog.slice(-800)}`)
  try { process.kill(-server.pid) } catch {}
  process.exit(1)
}
log(`  ✅ opencode serve 已在 :${PORT} 监听\n`)

// 2) SSE 探活
log('【准备】SSE 探活 …')
{
  const probe = await fetch(`${BASE}/event`, { headers: { accept: 'text/event-stream' } })
  if (probe.ok && probe.body) { log('  ✅ /event 可连接\n'); try { await probe.body.cancel() } catch {} }
  else bad('0-sse', `SSE 连接失败 HTTP ${probe.status}`, '用 curl 手工验证 /event')
}

// 3) 跑三项测试
log('─'.repeat(58))
log('测试 0-a：Windows 侧能否访问 WSL 的 localhost 服务')
const a = await testWindowsReach()
a.pass ? ok('0-a', `Windows → localhost:${PORT} 通  ${a.detail}`)
       : bad('0-a', a.detail, '如需从 Windows 访问，显式设置 PROBE_HOST=0.0.0.0（仅限可信网络）')
log('')

log('─'.repeat(58))
log('测试 0-b：免费模型能否通过 SSE 实时返回 reasoning part')
{
  const b = await testReasoning()
  b.pass ? ok('0-b', b.detail) : bad('0-b', b.detail, b.fallback)
}
log('')

log('─'.repeat(58))
log('测试 0-c：opencode.db 只读三表关联')
const c = testDb()
if (c.pass) {
  ok('0-c', `${c.note}｜${c.sessions} 会话 / ${c.messages} 消息 / ${c.parts} part`)
  log(`         part 类型分布: ${c.typeDist.map(t => `${t.t}=${t.n}`).join('  ')}`)
  log(`         思考过程 part: ${c.reasoningCount} 条  ← 这是 M4 思考面板的数据源`)
  for (const s of c.sample.slice(0, 2)) {
    log(`           [${s.role}] ${String(s.ptext).replace(/\s+/g, ' ').slice(0, 56)}…`)
  }
  log(`         历史 token 累计: 输入 ${c.tokenTotals.ti} / 输出 ${c.tokenTotals.to_} / 思考 ${c.tokenTotals.tr} / 花费 $${c.tokenTotals.c}`)
  log(`         子代理会话（parent_id非空）: ${c.parentTotal} 个${c.parentTotal === 0 ? '（你还没用过分派功能，正常）' : ''}`)
  } else {
  bad('0-c', c.detail, '历史记录改走 opencode API（需处理 basic auth）')
}

// 收尾
try { process.kill(-server.pid) } catch {}
try { server.kill() } catch {}

const passed = results.filter(r => r.pass).length
log('\n' + '═'.repeat(58))
log(`结果：${passed}/${results.length} 项通过`)
log('═'.repeat(58))
if (passed < results.length) {
  log('\n⚠️  有 FAIL 项 —— 请把上面的输出发我，先重新决策再往下做。')
  log('   不要跳过 M0 直接进 M1。')
}
process.exit(passed === results.length ? 0 : 1)