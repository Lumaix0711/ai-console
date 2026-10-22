#!/usr/bin/env node
// M1 · 数据层命令行验证 —— 不涉及任何 UI
// 用法：node M1-test.mjs
// 目的：在写界面之前证明数据层是对的。M3~M8 全部依赖这一层。
const OPENCODE_BIN = process.env.OPENCODE_BIN ||
  (process.env.HOME + '/.opencode/bin/opencode')
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { selfCheck, loadConfig } from './lib/paths.mjs'
import { closeDb, listSessions, getSessionTree, getMessages, getStats, listChildSessions } from './lib/db.mjs'
import { createClient } from './lib/sse.mjs'
import { createStore, wire } from './lib/normalize.mjs'
import { resolveModels } from './lib/models.mjs'

const cfg = loadConfig()
const PORT = cfg.upstream.port
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)
let fails = 0
const check = (name, cond, detail = '') => {
  if (cond) log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`)
  else { fails++; log(`  [FAIL] ${name}  ${detail}`) }
}

async function waitForPort(p, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const up = await new Promise(r => { const s = createConnection({ port: p, host: '127.0.0.1' }); s.on('connect', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
    if (up) return true
    await sleep(500)
  }
  return false
}

log('\n╔══════════════════════════════════════════════════════╗')
log('║   AI Console · M1 数据层验证                          ║')
log('╚══════════════════════════════════════════════════════╝\n')

// ─────────────────────────────────────────────────────────────
log('【1】路径自检（整个文件夹能否随便搬）')
const sc = selfCheck()
log(`  项目根: ${sc.root}`)
log(`  output: ${sc.outputDir}  存在=${sc.outputExists}`)
check('config.json 里没有写死的绝对路径', sc.absolutePathsInConfig.length === 0,
  sc.absolutePathsInConfig.length ? sc.absolutePathsInConfig.join(', ') : '(干净)')
log('')

// ─────────────────────────────────────────────────────────────
log('【2】只读数据库')
try {
  const st = getStats()
  check('读取统计', st.sessions > 0, `${st.sessions} 会话 / 花费 $${Number(st.cost).toFixed(4)}`)
  log(`  part 类型: ${st.parts.map(p => `${p.t}=${p.n}`).join('  ')}`)

  const ss = listSessions({ limit: 5 })
  check('listSessions', ss.length > 0, `返回 ${ss.length} 条`)
  for (const s of ss.slice(0, 3)) {
    log(`    · ${String(s.title).slice(0, 34).padEnd(36)} ${String(s.directory).slice(-28)}  消息${s.message_count} 思考${s.reasoning_count}`)
  }

  const withReasoning = ss.find(s => s.reasoning_count > 0)
  if (withReasoning) {
    const msgs = getMessages(withReasoning.id)
    const rsn = msgs.flatMap(m => m.parts).filter(p => p.type === 'reasoning')
    const tools = msgs.flatMap(m => m.parts).filter(p => p.type === 'tool')
    check('三表关联能取到思考过程', rsn.length > 0,
      `${msgs.length} 消息 / reasoning ${rsn.length} 段 / tool ${tools.length} 段`)
    if (rsn[0]) log(`    思考片段: ${String(rsn[0].text).replace(/\s+/g, ' ').slice(0, 60)}…`)
    if (tools[0]) log(`    工具示例: ${tools[0].tool} status=${tools[0].state?.status ?? '-'}`)
  } else {
    // 换个会话找
    let found = 0
    for (const s of listSessions({ limit: 30 })) {
      const ms = getMessages(s.id)
      const r = ms.flatMap(m => m.parts).filter(p => p.type === 'reasoning')
      if (r.length) { found = r.length; log(`    思考片段(来自 ${String(s.title).slice(0, 20)}): ${String(r[0].text).replace(/\s+/g, ' ').slice(0, 55)}…`); break }
    }
    check('三表关联能取到思考过程', found > 0, `${found} 段`)
  }

  const tree = getSessionTree()
  check('会话树', tree.count > 0, `${tree.count} 个节点，${tree.childCount} 个子代理会话`)
  if (tree.childCount) {
    for (const c of listChildSessions().slice(0, 3)) {
      log(`    子: ${c.id.slice(0, 16)}… parent=${String(c.parent_id).slice(0, 16)}… agent=${c.agent ?? '-'}`)
    }
  } else {
    log('    （子代理会话 0 个 —— M4 的自动分裂要等真派活后才有数据）')
  }
} catch (e) {
  fails++; log(`  [FAIL] 数据库访问异常: ${e.message}`)
}
log('')

// ─────────────────────────────────────────────────────────────
// 先把服务拉起来，第3节才能用 /provider 拿到 reasoning 标记（公开端点没有）
log('【0】拉起 opencode serve')
const server = spawn(OPENCODE_BIN, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let slog = ''
server.stdout.on('data', d => { slog += d }); server.stderr.on('data', d => { slog += d })
if (!await waitForPort(PORT)) {
  fails++; log(`  [FAIL] serve 没起来\n${slog.slice(-500)}`)
  closeDb(); try { process.kill(-server.pid) } catch {}; process.exit(1)
}
log(`  ✅ serve 已起 :${PORT}\n`)

// ─────────────────────────────────────────────────────────────
log('【3】模型解析（不硬编码，运行时拉）')
try {
  const r = await resolveModels({ baseUrl: BASE, force: true })
  log(`  来源: ${r.source}${r.reasoningUnknown ? '  ⚠️ 拿不到 reasoning 标记' : '  ✅ 含 capabilities.reasoning'}`)
  log(`  可用 ${r.allowed.length} 个 / 排除 ${r.blocked.length} 个`)
  for (const m of r.allowed) {
    const tag = `[T${m.tier}] ${m.tierLabel}`
    log(`    ✅ ${m.id.padEnd(30)} T${m.tier} ctx=${String(m.context ?? '?').padEnd(8)} reasoning=${m.reasoning}  ${tag}`)
  }
  for (const m of r.blocked) {
    log(`    ❌ ${m.id.padEnd(30)} ${m.reason}`)
  }
  check('至少解析出 1 个可用模型', r.allowed.length > 0)
  check('每个模型都有分层标记', r.allowed.every(m => typeof m.tier === 'number'))
  check('隐私黑名单全部拦住', r.blocked.filter(m => /nemotron|muse-spark/.test(m.id)).length >= 3,
    `拦下 ${r.blocked.filter(m => /nemotron|muse-spark/.test(m.id)).length} 个`)
  check('默认首选是 zero-retention 档', r.allowed[0]?.tier === 1, `首选 ${r.allowed[0]?.id} T${r.allowed[0]?.tier}`)
} catch (e) { fails++; log(`  [FAIL] ${e.message}`) }
log('')

// ─────────────────────────────────────────────────────────────
log('【4】SSE + normalize（实测事件流）')
const store = createStore()
const client = createClient({ baseUrl: BASE })
wire(store, client)
client.on('__open', () => log('  ✅ SSE 已连接'))
client.on('__close', (e) => log(`  ⚠️  SSE 断开: ${e.error}，${Math.round(e.backoff)}ms 后重连`))
client.connect()
await sleep(2000)

// 用模型解析挑一个可用模型
const mr = await resolveModels({ baseUrl: BASE, force: true })
const model = mr.allowed[0]?.id
check('运行时解析到模型', !!model, model ? `${model}  T${mr.allowed[0].tier}` : '（无）')
if (model) {
  const s = await (await fetch(`${BASE}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'M1-test ' + model }) })).json()
  log(`  会话已建: ${s.id}`)

  await fetch(`${BASE}/session/${s.id}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: { providerID: 'opencode', modelID: model },
      parts: [{ type: 'text', text: '用两三句话说明为什么 HTTPS 证书需要 CA 机构。' }],
    }),
  })

  log('  等待消息完成（只看 time.completed，不看 text 长度）…')
  let done = false
  for (let i = 0; i < 120; i++) {
    await sleep(1000)
    const st = store.snapshot()
    const ss2 = st.sessions.find(x => x.id === s.id)
    if (ss2 && ss2.completed > 0) { done = true; break }
  }
  await sleep(1500)

  const snap = store.snapshot()
  const mine = snap.sessions.find(x => x.id === s.id)
  log(`  收到 ${store.eventCount} 个事件`)
  log(`  未知事件类型: ${[...store.unknown.keys()].filter(k => !k.startsWith('session.') && !k.startsWith('message.') && !k.startsWith('plugin') && !k.startsWith('catalog') && !k.startsWith('reference') && !k.startsWith('integration') && !k.startsWith('server')).join(', ') || '无'}`)
  log(`  会话状态: ${mine?.status}  已完成消息 ${mine?.completed}  思考 ${mine?.reasoningChars} 字  正文 ${mine?.textChars} 字`)

  check('SSE 收到事件', store.eventCount > 10, `${store.eventCount} 个`)
  check('消息完成判定走 time.completed', done, done ? '正常' : '120秒未完成')
  check('normalize 累积到思考过程', (mine?.reasoningChars ?? 0) > 0, `${mine?.reasoningChars ?? 0} 字`)
  check('normalize 累积到正文', (mine?.textChars ?? 0) > 0, `${mine?.textChars ?? 0} 字`)

  const det = store.detail(s.id)
  const rsnParts = det?.messages.flatMap(m => m.parts).filter(p => p.type === 'reasoning') ?? []
  check('detail() 能取出 reasoning part', rsnParts.length > 0, `${rsnParts.length} 段`)
  if (rsnParts[0]) log(`   思考内容: ${String(rsnParts[0].text).replace(/\s+/g, ' ').slice(0, 70)}…`)

  // 自动分裂的机制验证：手工造一个带 parentID 的 session.created
  log('  验证「自动分裂」触发逻辑（注入一个带 parentID 的事件）…')
  store.apply({
    type: 'session.created',
    properties: { info: { id: 'ses_FAKE_CHILD_1', parentID: s.id, title: '假想子代理', directory: '/tmp' } },
  })
  const after = store.snapshot()
  check('带 parentID 的新 session 会自动分出一格',
    after.children.some(c => c.id === 'ses_FAKE_CHILD_1' && c.parentID === s.id),
    `根 ${after.roots.length} 个，子 ${after.children.length} 个`)

  await fetch(`${BASE}/session/${s.id}/abort`, { method: 'POST' }).catch(() => {})
}

client.close()
await sleep(300)
closeDb()
try { process.kill(-server.pid) } catch {}

log('\n' + '═'.repeat(58))
log(fails === 0 ? '结果：全部通过 ✅' : `结果：${fails} 项失败 ❌`)
log('═'.repeat(58))
process.exit(fails === 0 ? 0 : 1)