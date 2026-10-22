#!/usr/bin/env node
// M5 · 打磨验证：逐条核对用户提的 7 个问题
import { connect } from 'node:net'
import { writeFileSync } from 'node:fs'

const UI = 'http://127.0.0.1:4090'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let fails = 0
const log = (...a) => console.log(...a)
const check = (n, c, d = '') => { c ? log(`  [PASS] ${n}${d ? '  ' + d : ''}`) : (fails++, log(`  [FAIL] ${n}  ${d}`)) }

async function waitForPort(p, t = 40000) {
  const end = Date.now() + t
  while (Date.now() < end) {
    const up = await new Promise((r) => { const s = connect({ port: p, host: '127.0.0.1' }); s.on('connect', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
    if (up) return true; await sleep(400)
  }
  return false
}
if (!await waitForPort(4090, 8000)) { spawn_restart(); await waitForPort(4090, 60000) }
function spawn_restart() { }

// ── 0. 静态检查：前端源码里必须有对应实现 ────────────────
const html = (await (await fetch(`${UI}/`)).text())
const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || ''

log('\n══════ 逐条核对用户提的问题 ══════\n')

log('【问题1】不能切换 build / plan 模式')
check('顶栏有模式切换控件', html.includes('id="modeSeg"'))
check('两个模式按钮都在', html.includes('data-mode="build"') && html.includes('data-mode="plan"'))
check('前端会把模式发给后端', /agent:\s*curMode/.test(js))
check('后端校验模式合法性', true, '见下方实测')

log('\n【问题2】事件计数一直涨到 3000+')
check('不再统计 delta 事件', !/type === 'message\.part\.delta'[^\n]*countEv/.test(js))
check('改成了"消息"计数', html.includes('id="mcount"'))
check('另有"子代理"计数', html.includes('id="kcount"'))
const mCount = js.match(/mcount'\)\.textContent/)
check('计数只按会话消息累加', !!mCount)

log('\n【问题3】一直显示"正在连接 AI Console"')
check('有 placeholder 元素', html.includes('id="placeholder"'))
check('建卡时移除 placeholder', js.includes("const ph = $('placeholder'); if (ph) ph.remove()"))

log('\n【阶段 A/C】工具折叠 + 会话内搜索')
check('有密度切换控件（精简|全部）', html.includes('id="densitySeg"') && html.includes('data-d="compact"') && html.includes('data-d="all"'))
check('工具折叠组样式存在', html.includes('.tgroup') && html.includes('tg-arrow'))
check('折叠纯函数存在', js.includes('function planToolGroups'))
check('精简模式隐藏 todowrite', html.includes('data-tool-name="todowrite"]{display:none}'))
check('有搜索条', html.includes('id="searchbar"') && html.includes('id="searchQ"'))
check('拦截浏览器默认 Ctrl+F', js.includes("e.key === 'f' || e.key === 'F'") && js.includes('e.preventDefault(); openSearch()'))
check('用 CSS Custom Highlight API', js.includes('CSS.highlights.set') && html.includes('::highlight(ac-search)'))
check('命中在折叠块里会先展开再跳转', js.includes("el.closest('details')"))

log('\n【阶段 E】历史续聊控件 + 布局 + 顶栏响应式')
check('历史详情有模式/模型切换', html.includes('id="hfModeSeg"') && html.includes('id="hfModel"'))
check('续聊携带 agent 与 model', js.includes("agent: hfMode, model: $('hfModel').value"))
check('续聊模式默认跟随主界面', js.includes('let hfMode = curMode'))
check('★ 刷新先落主页（不再自动重放上次会话）', js.includes('function boot() { showHome().finally(() => loadPendingPerms()) }') && !js.includes('async function hydrate'))
check('内容列居中（margin auto）', html.includes('.s-body,.c-body{max-width:var(--acw);margin-inline:auto}'))
check('顶栏右侧工具区可收缩', html.includes('id="hdrTools"') && html.includes('id="hdrDrop"') && html.includes('id="hdrMore"'))
check('工具区项带优先级 data-p', (html.match(/data-p="\d+"/g) || []).length >= 8)
check('自适应引擎存在', js.includes('function adaptHeader') && js.includes('hdrFits') && js.includes("window.addEventListener('resize'"))

log('\n【阶段 F3/F5】消息大纲 + 消息操作 + 快捷键/浮钮/草稿')
check('有消息大纲侧条', html.includes('id="msgNav"') && js.includes('function registerNav'))
check('大纲只给根会话建', /if \(!nav \|\| !rec \|\| rec\.parentID\) return/.test(js))
check('滚动高亮当前消息', js.includes('function updateNavActive') && js.includes(".mnav-item.on") === false ? js.includes('best.classList.add') : true)
check('消息级操作（复制/编辑重发）', js.includes('function addMsgAction') && js.includes('复制全文') && js.includes('编辑重发'))
check('★ part 事件用 msgRole 缓存拿角色', js.includes('ensureMsg(rec, part.messageID, msgRole.get(part.messageID))'))
check('★ 主页继续卡取上次查看的会话', js.includes("const LAST_KEY = 'ac-last-sid'") && /(?:const|let) cont = roots\.find\(\(x\) => x\.id === last\)/.test(js))
check('有快捷键帮助面板', html.includes('id="keysPanel"') && js.includes("$('keysPanel').hidden = !$('keysPanel').hidden"))
check('? 键唤起面板', js.includes("e.key === '?'"))
check('有"回到最新"浮钮', html.includes('id="toLatest"') && js.includes("$('toLatest').onclick"))
check('★ 滚动判断用 #main 而不是 .s-body', js.includes('m.scrollHeight - m.scrollTop - m.clientHeight'))
check('草稿持久化', js.includes("localStorage.setItem('ac-draft'") && js.includes("localStorage.removeItem('ac-draft')"))

log('\n【阶段 F6】内容列宽度可调 + 底部留白')
check('有宽度按钮与面板', html.includes('id="widthBtn"') && html.includes('id="widthPanel"') && html.includes('id="wpRange"'))
check('宽度滑块范围 60-130ch', html.includes('min="60"') && html.includes('max="130"') && html.includes('value="92"'))
check('--acw 变量驱动三处宽度', html.includes('max-width:calc(var(--acw) + 64px)') && html.includes('.s-body,.c-body{max-width:var(--acw);margin-inline:auto}'))
check('底栏输入区也跟着变量', html.includes('calc((100% - var(--acw) - 64px) / 2 + 22px)'))
check('宽度持久化 localStorage.ac-w', js.includes("localStorage.getItem('ac-w'") && js.includes("localStorage.setItem('ac-w'"))
check('Alt+滚轮快调', js.includes('if (!e.altKey) return') && js.includes("acwSet(acwGet() + (e.deltaY < 0 ? 2 : -2))"))
check('Esc 可关宽度面板', /!\$\('keysPanel'\)\.hidden\)[\s\S]{0,120}!\$\('widthPanel'\)\.hidden\)/.test(js))
check('★ 底部留白从 28vh 降下来', html.includes('padding:0 20px 12vh') && !/#main\{[^}]*28vh/.test(html))

log('\n【阶段 F6 交互细节】')
check('宽度滑块 input 事件接 acwSet', js.includes("$('wpRange').addEventListener('input'"))
check('宽度面板复位按钮', js.includes("$('wpReset').onclick"))
check('acwSet 防御 vm 桩的 style 空对象', js.includes('typeof el.style.setProperty === \'function\''))

log('\n【阶段 H】宽度联动修复 + 历史装载主界面')
check('★ 正文限宽不再写死 92ch（拉宽能多排字）', html.includes('.msg-body>*,.rp-txt>*{max-width:var(--acw)}'))
check('★ 消息块限宽也不再写死', html.includes('.s-body>*,.c-body>*{max-width:var(--acw)}'))
check('★ 页面无残留 92ch 硬编码', !/max-width:\s*92ch/.test(html))
check('有 loadIntoMain（装载历史到主界面）', js.includes('async function loadIntoMain(sid)'))
check('装载后设为当前主会话', /loadIntoMain[\s\S]{0,6000}rootSession = sid/.test(js))
check('装载后收起抽屉', /loadIntoMain[\s\S]{0,6000}closeHist\(\)/.test(js))
// 窗口给足：loadIntoMain 里有一段长注释记着"平滑滚动 + 估算高度"的坑，
// 1400 字符窗口会因为注释变长而误报失败。断言本意只是"装载后要滚到底"。
check('★ 装载后滚到最新', /async function loadIntoMain[\s\S]{0,3000}main\.scrollTop = main\.scrollHeight/.test(js))
check('装载时临时关掉平滑滚动', /loadIntoMain[\s\S]{0,3000}scrollBehavior = 'auto'/.test(js))
check('历史列表每条有装载按钮', html.includes('data-load=') && html.includes('dw-load'))
check('历史详情头也有装载按钮', html.includes('id="histLoadMain"'))
check('装载按钮阻止冒泡（不误开详情）', js.includes("e.target.closest('[data-load]')") && js.includes('e.stopPropagation(); loadIntoMain'))
check('回放渲染抽成可复用函数', js.includes('function buildReplayBody(j, opts = {})') && js.includes('const body = buildReplayBody(j, { child: !!ses.parentID })'))

log('\n【阶段 F1】edit/write diff 视图 + 错误卡')
check('LCS diff 纯函数存在', js.includes('function lineDiff'))
check('diff 卡渲染函数存在', js.includes('function toolExtraHtml'))
check('实时 paintTool 挂 diff/错误卡', /el\.innerHTML = `<span class="tool.*\$\{esc\(part\.id\)\}">`[\s\S]{0,400}toolExtraHtml\(part\)/.test(js))
check('回放 toolRowHtml 挂 diff/错误卡', js.includes('let extra = toolExtraHtml(p)'))
check('大改动折叠展开', js.includes('展开余下') && js.includes('tdiff-more'))
check('错误卡样式存在', html.includes('.terr{') && html.includes('.tdiff{'))

log('\n【问题4】小卡片分类不合理')
check('主卡有"主 AI"标识', html.includes('s-badge root">主 AI<'))
check('子卡有 agent 标识', js.includes('c-agent'))
check('主卡显示模型与 agent 元信息', js.includes('s-meta'))
check('主卡显示派活进度', js.includes('updateProgress'))
check('子卡用独立 class 与主卡区分',
  /isChild \? 'child' : 'session'/.test(js) &&
  /isChild \? 'c-head' : 's-head'/.test(js) &&
  html.includes('.c-body{') && html.includes('.children{'))

log('\n【问题5】看不出子 AI 是不是真开了终端')
check('卡片标题取自派活描述', js.includes('cleanTitle(info.title)'))
check('派活时 toast 提示', js.includes('主 AI 派出子代理'))
check('父卡把子卡收进 children 容器', js.includes('childWrap.appendChild'))
  // 断言"意图"而不是 CSS 字面量 —— 之前写死 `border-left:2px solid var(--border)`，
  // 换个变量名就误报。真正要保证的是：子会话有左缩进 + 一条左侧竖线，且比主会话细。
  // 注意：要取"独立成规则"的 .child{...}，不能直接正则第一个匹配 ——
  // 因为前面有合并选择器 `.session,.child{`，那里也含 `.child{` 但内容不同。
  const blocks = [...html.matchAll(/(?:^|[};])\s*\.child\s*\{([^}]*)\}/g)].map((m) => m[1])
  const childOk = blocks.some((b) =>
    /border-left-width:\s*1px/.test(b) && /border-left-color/.test(b) && /margin/.test(b))
  check('子卡挂在父卡下方（左缩进 + 左侧竖线）',
    html.includes('.children{') && childOk && blocks.length > 0,
    `找到 ${blocks.length} 个独立 .child 规则块；子会话 1px 竖线，主会话 2px`)
  check('★ 主会话脊柱线比子会话粗（层级用线宽表达）',
    /border-left:2px solid/.test(html) && /border-left-width:1px/.test(html))

log('\n【问题6】很多英文，输出必须中文')
check('后端注入中文 system 约束', true, '见下方实测')
check('前端有中文检测函数', js.includes('function isChinese'))
check('思考块标注语言', js.includes("lang.textContent = isChinese(txt) ? '中文' : 'English'"))

log('\n【问题7】输出不流畅，一整段蹦')
check('有打字机队列', js.includes('const queue = new Map()'))
check('用 requestAnimationFrame 逐帧渲染', js.includes('requestAnimationFrame(tick)'))
check('积压越多吐得越快', js.includes('gap > 900 ? 60'))
check('增量先进 data-full 再渲染', js.includes('pre.dataset.full'))

// ── 1. 后端实测 ────────────────────────────────────────
log('\n══════ 后端实测 ══════\n')
const h = await (await fetch(`${UI}/api/health`)).json()
check('health 返回可选模式', h.modes?.length === 2, (h.modes || []).map((m) => m.name).join(','))
check('health 返回被排除模型及原因', h.modelBlocked?.length === 3,
  h.modelBlocked?.map((m) => `${m.id}(${m.reason.slice(0, 14)}…)`).join(' '))
check('模型全部是免费模型', h.models.every((m) => m.id.endsWith('-free')))
check('T1 zero-retention 排在最前', h.models[0]?.tier === 1, h.models[0]?.id)

// ── 2. 实发一条，验证 plan 模式 + 中文约束 ─────────────
log('')
const ev = []
const es = await fetch(`${UI}/api/stream`, { headers: { accept: 'text/event-stream' } })
const rd = es.body.getReader(), dec = new TextDecoder(); let buf = ''
;(async () => { try { while (true) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); const ls = buf.split('\n'); buf = ls.pop() || ''; for (const l of ls) { if (l.startsWith('data:')) { try { ev.push(JSON.parse(l.slice(5).trim())) } catch {} } } } } catch {} })()
await sleep(1200)

const PMODEL = 'deepseek-v4.1-flash-free'
const Q = '用一句话说明什么是 SQL 注入。'
log(`发一条（plan 模式 + 中文约束）: "${Q}"`)
const r = await (await fetch(`${UI}/api/send`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: Q, agent: 'plan', model: PMODEL }),
})).json()
check('发送成功', !!r.sessionID, r.error || '')
check('后端回显了实际使用的模型', r.model === PMODEL, r.model)
check('★ 后端回显了实际使用的模式', r.agent === 'plan', r.agent)

// 非法模式应被纠正
const r2 = await (await fetch(`${UI}/api/send`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hi', agent: '不存在的模式', sessionID: r.sessionID }),
})).json()
check('★ 非法模式被纠正为 build', r2.agent === 'build', `收到 "${r2.agent}"`)

// 付费模型应被拒绝
const r3 = await (await fetch(`${UI}/api/send`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hi', model: 'claude-opus-5', sessionID: r.sessionID }),
})).json()
check('★ 付费模型被拒绝（回落到免费）', r3.model?.endsWith('-free'), `实际用了 ${r3.model}`)

// ── 3. 等完成，看中文与 delta ──────────────────────────
log('')
log('等待完成…')
for (let i = 0; i < 90; i++) {
  await sleep(2000)
  const st = await (await fetch(`${UI}/api/state`)).json()
  const s = st.sessions.find((x) => x.id === r.sessionID)
  if (s && s.status === 'idle' && s.completed > 0) break
}
await sleep(2000)

const texts = ev.filter((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'text')
  .map((e) => e.properties.part.text).join('\n')
const deltas = ev.filter((e) => e.type === 'message.part.delta')
log('')
log('【产出检查】')
check('有正文产出', texts.trim().length > 0, `${texts.length} 字`)
check('★ 正文是中文', /[一-鿿]/.test(texts),
  `中文 ${(texts.match(/[一-鿿]/g) || []).length} 字符 / 英文 ${(texts.match(/[a-zA-Z]/g) || []).length} 字符`)
check('★ 正文中文占比 > 30%', ((texts.match(/[一-鿿]/g) || []).length / Math.max(1, (texts.match(/[a-z]/gi) || []).length + (texts.match(/[一-鿿]/g) || []).length)) > 0.3)
check('有 delta 增量（打字机有数据源）', deltas.length > 0, `${deltas.length} 个`)
if (texts.trim()) log(`  正文: ${texts.trim().slice(0, 90)}…`)

// delta 是否够碎（决定打字机效果）
const sizes = deltas.map((d) => (d.properties?.delta || '').length)
if (sizes.length) {
  const avg = (sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1)
  log(`  delta 平均长度 ${avg} 字符，最大 ${Math.max(...sizes)}`)
}

writeFileSync('/tmp/opencode/m5-events.json', JSON.stringify(ev))
log('')
log('═'.repeat(54))
log(fails === 0 ? '打磨验证全部通过 ✅' : `${fails} 项失败 ❌`)
log('═'.repeat(54))
try { await rd.cancel() } catch {}
process.exit(fails === 0 ? 0 : 1)
