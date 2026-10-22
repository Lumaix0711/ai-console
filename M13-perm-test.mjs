// M13：权限审批（SSE permission.asked/updated → 审批卡 → 回复上游）
// 链路：上游 permission.asked（1.19）或 permission.updated（1.18）→ 会话头下方插审批卡
//   → POST /api/permission/reply → 上游 POST /session/:id/permissions/:permissionID
//   → permission.replied 事件清卡（任何来源的回复都清，单一事实源）。
// 字段形状兼容 1.18 SDK（type/pattern）与 1.19 服务端（permission/patterns）两种，
// 回复事件兼容 1.18（permissionID/response）与 1.19 实测（requestID/reply）两种。
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

// ── 事件钩子存活验证 ─────────────────────────────
const handle = ctx.handle
if (typeof handle !== 'function' || typeof ctx.permNorm !== 'function') {
  console.error('❌ handle / permNorm 没挂上，vm 环境不对'); process.exit(1)
}

console.log('【字段归一化（1.18 / 1.19 两种形状都要认）】')
{
  const a = ctx.permNorm({ id: 'per_1', sessionID: 'ses_1', type: 'bash', pattern: 'rm -rf build' })
  t('18 形状：type + 单个 pattern', a.title === 'bash' && a.pats.length === 1 && a.pats[0] === 'rm -rf build')
  const b = ctx.permNorm({ id: 'per_2', sessionID: 'ses_2', permission: 'edit', patterns: ['src/**', 'app/**'] })
  t('19 形状：permission + patterns 数组', b.title === 'edit' && b.pats.length === 2)
  const c = ctx.permNorm({ id: 'per_3', sessionID: 'ses_3' })
  t('都没有时给保底标题', c.title === '操作' && c.pats.length === 0)
}

console.log('【事件 → 徽章/标题（可观测副作用）】')
{
  handle({ type: 'permission.updated', properties: { id: 'per_A', sessionID: 'ses_NOPE', title: 'bash', pattern: ['echo *'] } })
  t('收到 permission.updated 后标题带「待授权」', String(ctx.document.title).includes('待授权'), `title=${ctx.document.title}`)
  // 重复推送同一条不能重复计数（事件流里 permission.updated 会重发）
  const before = ctx.document.title
  handle({ type: 'permission.updated', properties: { id: 'per_A', sessionID: 'ses_NOPE', title: 'bash', pattern: ['echo *'] } })
  t('按 id 去重：重复事件标题不变', ctx.document.title === before)
  handle({ type: 'permission.replied', properties: { sessionID: 'ses_NOPE', permissionID: 'per_A', response: 'once' } })
  t('permission.replied 后标题还原', ctx.document.title === 'AI Console', `title=${ctx.document.title}`)
  // 1.19 服务端实测形状（2026-10-18 live 抓包）：事件名 asked、回复事件用 requestID/reply
  handle({ type: 'permission.asked', properties: { id: 'per_B', sessionID: 'ses_NOPE', permission: 'external_directory', patterns: ['/etc/*'] } })
  t('1.19 permission.asked 也点亮徽章', String(ctx.document.title).includes('待授权'), `title=${ctx.document.title}`)
  handle({ type: 'permission.replied', properties: { sessionID: 'ses_NOPE', requestID: 'per_B', reply: 'once' } })
  t('1.19 replied（requestID/reply）能清卡', ctx.document.title === 'AI Console', `title=${ctx.document.title}`)
  // 没有 id 的老形状：不崩、不重复
  handle({ type: 'permission.updated', properties: { sessionID: 'ses_NOPE' } })
  t('缺 id 的旧形状不崩', true)
}

console.log('【后端代理路由（server.mjs）】')
t('回复路由存在', srv.includes("'/api/permission/reply'"))
t('只放行三种响应', srv.includes("['once', 'always', 'reject']"))
t('透传上游文档端点', srv.includes('/session/${sessionID}/permissions/${permissionID}'))
t('回复体只发 response 字段', srv.includes('JSON.stringify({ response })'))
t('待审批列表路由存在', srv.includes("'/api/permissions'") && srv.includes('/permission`'))
t('上游错误往上传（502 + detail）', /permission\/reply[\s\S]{0,600}5402/.test(srv) || srv.includes("error: `上游 HTTP ${r.status}`"))

console.log('【前端接线（静态断言）】')
t('顶栏徽章按钮 + 计数', html.includes('id="permBtn"') && html.includes('id="permCount"'))
t('三个动作按钮齐全', html.includes('允许一次') && html.includes('总是允许') && html.includes('拒绝'))
t('审批卡样式存在', html.includes('.perm-card{') && html.includes('.perm-hit'))
t('回复走本地代理', js.includes("fetch('/api/permission/reply'"))
t('卡片由 permission.replied 清理（两版 id 字段）', js.includes("ev.type === 'permission.replied'") && js.includes('dropPerm(p.permissionID || p.requestID)'))
t('实时事件两版事件名都监听', js.includes("ev.type === 'permission.updated' || ev.type === 'permission.asked'") || js.includes("ev.type === 'permission.asked'"))
t('会话卡重建补挂（回到实时后）', js.includes('paintPermsFor(sid)'))
t('中止会话清掉它的审批卡', js.includes('for (const [pid2, e] of [...pendingPerms])'))
t('刷新后从上游回填', js.includes('loadPendingPerms') && js.includes('showHome().finally(() => loadPendingPerms())'))
t('回填不弹 toast（quiet）', js.includes("properties: item }, true)"))
t('上游字段用 textContent 注入（防注入）', js.includes("card.querySelector('.pc-meta').textContent = n.title") && !/\$\{n\.(title|pats)/.test(js))
t('回复成功后 10s 兜底清卡', /setTimeout\(\(\) => \{ if \(pendingPerms\.has\(p\.id\)\) dropPerm\(p\.id\) \}, 10000\)/.test(js))
t('徽章点击有钉住态提示', js.includes("主界面钉在历史会话上——先点顶栏「回到实时」再看授权"))
t('徽章点击可装载未打开的会话再定位', js.includes('await loadIntoMain(pend.p.sessionID)'))
t('装载后恢复等待授权琥珀态', js.includes("setStatus(pend.p.sessionID, 'waiting')"))

// ── 服务在跑时的接口冒烟（不在就跳过，不算失败）────
console.log('【接口冒烟（服务未运行则跳过）】')
try {
  const base = 'http://127.0.0.1:' + (process.env.UI_PORT || 4090)
  const r1 = await fetch(base + '/api/permissions').then((r) => r.json())
  t('GET /api/permissions 返回 {ok, list[]}', r1.ok === true && Array.isArray(r1.list))
  const r2 = await fetch(base + '/api/permission/reply', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  t('空参数被 400 拦截', r2.status === 400)
} catch {
  console.log('  [SKIP] 服务未运行，接口冒烟跳过')
}

console.log('')
console.log(fails === 0 ? 'M13 全部通过 ✅' : `${fails} 项失败 ❌`)
process.exit(fails ? 1 : 0)
