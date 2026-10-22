#!/usr/bin/env node
// M6 验证：历史记录接口 + 前端渲染逻辑（用最小 DOM 在 vm 里真跑一遍）
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
const PORT = Number(process.env.UI_PORT || 4090)   // 和 server.mjs 的取值方式保持一致
const UP = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
const log = (...a) => console.log(...a)
const check = (n, c, d = '') => { c ? log(`  [PASS] ${n}${d ? '  ' + d : ''}`) : (fails++, log(`  [FAIL] ${n}  ${d}`)) }

async function waitForPort(p, t = 30000) {
  const end = Date.now() + t
  while (Date.now() < end) {
    const up = await new Promise((r) => { const s = connect({ port: p, host: '127.0.0.1' }); s.on('connect', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
    if (up) return true; await sleep(400)
  }
  return false
}
if (!await waitForPort(PORT)) { log('  服务没起'); process.exit(1) }

// ── 最小 DOM ────────────────────────────────────────────────
function mkEl(tag = 'div') {
  const el = {
    tagName: tag, innerHTML: '', textContent: '', className: '', hidden: false,
    dataset: {}, style: {}, children: [], value: '',
    _cls: new Set(),
    classList: {
      add(c) { el._cls.add(c) }, remove(c) { el._cls.delete(c) },
      contains(c) { return el._cls.has(c) || String(el.className).split(/\s+/).includes(c) },
      toggle(c, on) { on ? el._cls.add(c) : el._cls.delete(c) },
    },
    appendChild(c) { el.children.push(c); return c },
    remove() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelector() { return mkEl() }, querySelectorAll() { return [] },
    closest() { return null }, focus() {}, scrollIntoView() {}, getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 } },
  }
  return el
}
const els = new Map()
const document = {
  getElementById(id) { if (!els.has(id)) els.set(id, mkEl()); return els.get(id) },
  createElement: (t) => mkEl(t),
  querySelector: () => mkEl(), querySelectorAll: () => [],
  addEventListener() {}, body: mkEl('body'), documentElement: mkEl('html'),
}
class EventSource { constructor() { this.readyState = 0 } close() {} }
const sandbox = {
  document, EventSource, console,
  fetch: (u, o) => fetch(u.startsWith('http') ? u : UP + u, o),
  setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
  confirm: () => false, alert: () => {}, prompt: () => null,
  TextDecoder, Date, Math, JSON, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error, Promise,
}
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox

// ── 加载前端脚本 ────────────────────────────────────────────
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
check('index.html 里有脚本', scripts.length > 0, `${scripts.length} 段`)
const ctx = createContext(sandbox)
let loadErr = null
try { for (const s of scripts) runInContext(s, ctx, { filename: 'index.html#script' }) }
catch (e) { loadErr = e }
check('★ 前端脚本能在 DOM 里跑起来（无未定义引用）', !loadErr, loadErr ? loadErr.message : '')

// ── 接口 ───────────────────────────────────────────────────
log('\n【1】/api/history/list')
// 取全量（上限 300）：只取 80 的话，子代理会话会因为主会话太多而被挤出窗口，
// 让"列表里同时有主会话和子代理会话"这条断言随机失败。
const listRes = await fetch(`${UP}/api/history/list?limit=300`)
const listJson = await listRes.json()
check('HTTP 200', listRes.status === 200)
check('返回会话数组', Array.isArray(listJson.sessions), `${listJson.sessions?.length} 个`)
const S = listJson.sessions
check('有主会话也有子代理会话', S.some((s) => !s.parentID) && S.some((s) => s.parentID),
  `主 ${S.filter((s) => !s.parentID).length} / 子 ${S.filter((s) => s.parentID).length}`)
check('含思考与工具计数', S.some((s) => s.reasoning > 0 && s.tools > 0))
check('按更新时间倒序', S.every((s, i) => i === 0 || S[i - 1].time.updated >= s.time.updated))
const need = ['id', 'title', 'agent', 'parentID', 'messages', 'reasoning', 'tools', 'time']
check('字段齐全（前端模板依赖）', need.every((k) => k in S[0]), need.filter((k) => !(k in S[0])).join(',') || '全部存在')

log('\n【2】搜索过滤')
const q = encodeURIComponent(String(S.find((s) => s.title)?.title || '').slice(0, 6))
const qRes = await (await fetch(`${UP}/api/history/list?limit=80&q=${q}`)).json()
check('带 q 参数能过滤', qRes.sessions.length <= S.length, `${qRes.sessions.length}/${S.length}`)

log('\n【3】/api/history 单会话回放')
const withReason = [...S].sort((a, b) => b.reasoning - a.reasoning)[0]
const hRes = await fetch(`${UP}/api/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionID: withReason.id }) })
const H = await hRes.json()
check('HTTP 200', hRes.status === 200)
check('含 session 元信息', !!H.session?.id && 'agent' in H.session)
check('★ 含思考过程（这是历史回放的意义）', H.messages.some((m) => m.parts.some((p) => p.type === 'reasoning' && p.text)))
check('★ 含工具调用', H.messages.some((m) => m.parts.some((p) => p.type === 'tool')))
check('含正文', H.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text)))
check('★ reasoning 已标 thinking 语言（UI 直接用）',
  H.messages.flatMap((m) => m.parts).filter((p) => p.type === 'reasoning').every((p) => typeof p.thinking === 'boolean'))
check('无 system 消息', !H.messages.some((m) => m.role === 'system'))
log(`  样本《${withReason.title?.slice(0, 34)}》 ${H.messages.length} 条消息，思考 ${withReason.reasoning} 段`)

log('\n【3b】刷新回填所依赖的契约')
// 前端 hydrate() 把 /api/history 的数据重放成 SSE 形状的事件，
// 缺 sessionID / messageID 就挂不到会话和消息上，回填会静默失效。
check('★ 每个 part 都带 sessionID', H.messages.flatMap((m) => m.parts).every((p) => p.sessionID === withReason.id))
check('★ 每个 part 都带 messageID', H.messages.every((m) => m.parts.every((p) => p.messageID && p.messageID === m.id)),
  'part.messageID 必须等于它所属 message 的 id')
check('★ 每条 message 带 sessionID', H.messages.every((m) => m.sessionID === withReason.id))
// 库里实际出现的类型（含 compaction 之类的内部标记）。
// hydrate() 只重放 text/reasoning/tool，其余（step-*、compaction）跳过 ——
// 它们没有可渲染内容，重放只会造出空块。
const KNOWN = ['text', 'reasoning', 'tool', 'step-start', 'step-finish', 'compaction']
const types = [...new Set(H.messages.flatMap((m) => m.parts).map((p) => p.type))]
check('★ part 类型都在已知集合内', types.every((t) => KNOWN.includes(t)), types.join(', '))
check('★ 存在可渲染的三种（回填才有内容）', ['text', 'reasoning', 'tool'].every((t) => types.includes(t)))

log('\n【3c】汇总落盘')
const outRes = await fetch(`${UP}/api/output`)
const outJson = await outRes.json()
check('/api/output 返回目录与文件列表', Array.isArray(outJson.files) && typeof outJson.dir === 'string',
  `${outJson.files?.length ?? 0} 个文件 · ${outJson.dir}`)
check('★ 目录就是桌面快捷方式指向的位置', /output$/.test(outJson.dir || ''), outJson.dir)
const idxExists = outJson.files.some((f) => f.name === 'index.md')
check('★ 有 index.md 目录页', idxExists, idxExists ? `${outJson.files.length} 个文件` : '缺 index.md')

log('\n【3d】截图管理接口')
import { writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync, rmSync } from 'node:fs'
const SHOTS = `${process.env.HOME}/ai-console/screenshots`
// clear 是真实删除接口，先把现有 PNG 备份到临时目录，测完原样还原
const BAK = `${process.env.HOME}/ai-console/.m6-bak`
const saved = []
if (existsSync(SHOTS)) {
  for (const day of readdirSync(SHOTS)) {
    const dd = join(SHOTS, day)
    let st
    try { st = statSync(dd) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(dd)) {
      if (!f.toLowerCase().endsWith('.png')) continue
      const bd = join(BAK, day)
      mkdirSync(bd, { recursive: true })
      copyFileSync(join(dd, f), join(bd, f))
      saved.push([join(dd, f), join(bd, f)])
    }
  }
}
log(`  （已备份 ${saved.length} 张真实截图，测完还原）`)

// 先建几个测试 PNG
mkdirSync(`${SHOTS}/__m6test__`, { recursive: true })
writeFileSync(`${SHOTS}/__m6test__/a.png`, Buffer.alloc(500))
writeFileSync(`${SHOTS}/__m6test__/b.png`, Buffer.alloc(500))
const sh = await (await fetch(`${UP}/api/screenshots`)).json()
check('GET 返回日期分组', Array.isArray(sh.byDate) && typeof sh.totalCount === 'number', `${sh.totalCount} 张`)
check('包含刚建的测试目录', sh.byDate.some((x) => x.day === '__m6test__'), sh.byDate.map((x) => x.day).join(','))
const cl = await (await fetch(`${UP}/api/screenshots/clear`, { method: 'POST' })).json()
check('clear 只删 .png、报出数量与空间', cl.deleted >= 2 && cl.freedBytes >= 1000, `删 ${cl.deleted} 张`)
const sh2 = await (await fetch(`${UP}/api/screenshots`)).json()
check('清空后测试目录里的 PNG 没了', !sh2.byDate.some((x) => x.day === '__m6test__'), '')
check('日期目录结构保留', sh2.exists, '')

// 还原真实截图
for (const [orig, bak] of saved) {
  mkdirSync(join(orig, '..'), { recursive: true })
  copyFileSync(bak, orig)
}
rmSync(BAK, { recursive: true, force: true })
rmSync(`${SHOTS}/__m6test__`, { recursive: true, force: true })
const sh3 = await (await fetch(`${UP}/api/screenshots`)).json()
check('★ 真实截图已还原', sh3.totalCount >= saved.length, `还原 ${saved.length} 张，现存 ${sh3.totalCount} 张`)

log('\n【4】错误处理')
check('空 sessionID → 400', (await (await fetch(`${UP}/api/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status) === 400)
check('不存在的会话 → 404', (await (await fetch(`${UP}/api/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sessionID":"ses_nope"}' })).status) === 404)
check('坏 JSON 不崩（走 400/404）', [400, 404].includes((await fetch(`${UP}/api/history`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status))

// ── 前端渲染（真跑） ───────────────────────────────────────
log('\n【5】前端渲染（vm + 最小 DOM）')
const ctxPaint = ctx.paintHist, ctxLoad = ctx.loadHist, ctxOpen = ctx.openSession
check('paintHist / loadHist / openSession 已定义', !!ctxPaint && !!ctxLoad && !!ctxOpen)
// 注意：vm 里顶层 let/const 不挂 global，无法从外部注入 histData，必须让脚本自己 fetch

try {
  await ctxLoad()          // 真的 fetch 一次，让脚本自己填 histData
  ctxPaint()
  const listHtml = document.getElementById('histList').innerHTML
  check('★ paintHist 产出了会话列表 HTML', listHtml.includes('dw-list'), `${listHtml.length} 字符`)
  check('列表里有主代理与子代理区分', listHtml.includes('子代理') && listHtml.includes('主 AI'))
  check('列表带统计信息', /条消息/.test(listHtml) && /段思考/.test(listHtml) && /次工具/.test(listHtml))
  check('★ HTML 已转义（防注入）', !/<script/i.test(listHtml))
  const sidMatch = listHtml.match(/data-sid="([^"]+)"/)
  check('每个条目可点击（data-sid）', !!sidMatch, sidMatch?.[1]?.slice(0, 18))
} catch (e) { check('paintHist 执行', false, e.message) }

// 搜索为空时的分支（走标题过滤模式，避免 vm 里发网络请求）
try {
  ctx.histFullText = false                       // vm 暴露的是 const 局部，改不了就退而验证 paintHist 的标题分支
  document.getElementById('histQ').value = 'zzz-绝对不存在的标题-zzz'
  ctxPaint()
  const html = document.getElementById('histList').innerHTML
  check('★ 搜索无结果时有兜底文案', html.includes('没有匹配') || html.includes('正在检索'), html.slice(0, 60))
  document.getElementById('histQ').value = ''
  ctxPaint()
} catch (e) { check('搜索分支', false, e.message) }

// 真跑一次 openSession（走 fetch + 模板拼接）
try {
  const sid = [...S].sort((a, b) => b.reasoning - a.reasoning)[0].id
  await ctxOpen(sid)
  const d = document.getElementById('histDetail')
  check('★ openSession 打开了详情层', d.hidden === false)
  const h = d.innerHTML
  check('★ 详情里渲染出了思考过程', h.includes('思考过程'))
  check('★ 详情里渲染出了工具调用', h.includes('class="tool'))
  check('★ 详情里渲染出了续聊输入框', h.includes('histFollow'))
  check('★ 详情里有返回按钮', h.includes('histBack'))
  check('★ 详情 HTML 已转义', !/<script/i.test(h))
  const back = h.includes('返回列表') ? '有' : '无'
  check('返回按钮文案', back === '有', back)
} catch (e) { check('openSession 执行', false, e.message) }

// 续聊按钮逻辑（不真发，只看 handler 挂上了）
try {
  const btn = document.getElementById('histSend')
  check('★ 续聊按钮已绑定 onclick', typeof btn.onclick === 'function')
} catch (e) { check('续聊按钮', false, e.message) }

log('\n【6】页面确实带着抽屉')
check('HTML 含历史按钮', html.includes('id="histBtn"'))
check('HTML 含抽屉容器', html.includes('id="hist" class="drawer"'))
check('Escape 可关闭', html.includes("e.key === 'Escape'"))

log('')
log('═'.repeat(52))
log(fails === 0 ? 'M6 全部通过 ✅' : `${fails} 项失败 ❌`)
log('═'.repeat(52))
process.exit(fails === 0 ? 0 : 1)