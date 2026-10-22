// M14：待办条（todo.updated 整表快照 + GET /session/:id/todo 回填 → 会话头下折叠条）
// 链路：上游 todo.updated {sessionID, todos[]} → todoState 覆盖 → renderTodos 重绘
//   → 首次见到会话时 GET /api/todo?sessionID= 回填（404/失败静默）。
// 上游实测：GET /session/:id/todo 返回 [{content,status,priority}]（无 id），
//   状态 ∈ pending | in_progress | completed | cancelled。
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const srv = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
const mk = () => ({
  innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, hidden: false,
  classList: { add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return mk() }, querySelectorAll() { return [] }, closest() { return null },
  after() {}, prepend() {},
})
const ctx = createContext({
  document: { getElementById: mk, createElement: mk, querySelector: mk, querySelectorAll: () => [], addEventListener() {}, body: mk(), documentElement: mk(), title: '' },
  EventSource: class { close() {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: (s) => String(s) }, confirm: () => false, alert() {}, TextDecoder, localStorage: { getItem: () => null, setItem() {} },
  fetch: () => Promise.reject(new Error('x')), window: null,
})
ctx.window = ctx
try { runInContext(js, ctx, { filename: 'ui.js' }) } catch (e) { if (!/getElementById/.test(e.message)) throw e }

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

// ── 纯函数：todoSummary ─────────────────────────────
if (typeof ctx.todoSummary !== 'function') {
  console.error('❌ todoSummary 没挂上，vm 环境不对'); process.exit(1)
}
console.log('【todoSummary（完成/进行中/总数）】')
{
  const e = ctx.todoSummary([])
  t('空列表', e.total === 0 && e.done === 0 && e.label === '待办 0/0')
  const m = ctx.todoSummary([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'cancelled' },
  ])
  t('混合状态计数正确', m.total === 4 && m.done === 1 && m.doing === 1 && m.label === '待办 1/4')
  const all = ctx.todoSummary([{ status: 'completed' }, { status: 'completed' }])
  t('全部完成', all.done === 2 && all.doing === 0)
}

console.log('【事件 → 不崩（无 DOM 会话时静默）】')
{
  const h = ctx.handle
  if (typeof h !== 'function') { console.error('❌ handle 没挂上'); process.exit(1) }
  h({ type: 'todo.updated', properties: { sessionID: 'ses_NOPE', todos: [{ content: 'x', status: 'pending' }] } })
  t('todo.updated 正常消化', true)
  h({ type: 'todo.updated', properties: { sessionID: 'ses_NOPE', todos: 'not-array' } })
  t('todos 非数组不崩（落成空表）', true)
  h({ type: 'todo.updated', properties: {} })
  t('缺 sessionID 不崩', true)
}

console.log('【后端代理路由（server.mjs）】')
t('路由存在', srv.includes("'/api/todo'"))
t('缺 sessionID 被 400 拦截', /api\/todo'[\s\S]{0,200}缺 sessionID[\s\S]{0,80}400/.test(srv))
t('透传上游 todo 端点', srv.includes('/session/${encodeURIComponent(sid)}/todo'))
t('上游 404 时返回 ok:false（不炸前端）', /api\/todo'[\s\S]{0,600}ok: false/.test(srv))

console.log('【前端接线（静态断言）】')
t('handle 里有 todo.updated 分支', js.includes("ev.type === 'todo.updated' && p.sessionID"))
t('整表覆盖语义', js.includes('todoState.set(p.sessionID, Array.isArray(p.todos) ? p.todos : [])'))
t('会话卡重建时回填', js.includes('loadTodos(sid)'))
t('回填走本地代理', js.includes("fetch('/api/todo?sessionID='"))
t('折叠条样式存在（含 [hidden] 覆盖）', html.includes('.todo-strip{') && html.includes('.todo-strip .ts-list[hidden]{display:none}'))
t('内容用 textContent 注入（防注入）', js.includes("txt.textContent = String(t.content || '')") && !/\$\{t\.content/.test(js))
t('审批卡优先：待办条挂在审批卡之后', js.includes("const anchor = pcs.length ? pcs[pcs.length - 1] : head"))

// ── 服务在跑时的接口冒烟（不在就跳过，不算失败）────
console.log('【接口冒烟（服务未运行则跳过）】')
try {
  const base = 'http://127.0.0.1:' + (process.env.UI_PORT || 4090)
  const r1 = await fetch(base + '/api/todo')
  t('缺参数被 400 拦截', r1.status === 400)
  const r2 = await fetch(base + '/api/todo?sessionID=ses_doesnotexist').then((r) => r.json())
  t('不存在的会话给 ok:false（静默）', r2.ok === false)
  const hl = await fetch(base + '/api/history/list?limit=8').then((r) => r.json())
  const rows = hl.sessions || []
  let withTodos = 0
  for (const s of rows) {
    const j = await fetch(base + '/api/todo?sessionID=' + encodeURIComponent(s.id)).then((r) => r.json())
    if (j.ok && Array.isArray(j.todos)) withTodos++
  }
  t(`回填形状：${rows.length} 个真实会话全部返回 {ok:true, todos[]}`, rows.length === 0 || withTodos === rows.length, `withTodos=${withTodos}/${rows.length}`)
} catch { console.log('  [SKIP] 服务没在跑，跳过接口冒烟') }

console.log(fails ? `\n${fails} 项失败 ❌` : '\nM14 全部通过 ✅')
process.exit(fails ? 1 : 0)
