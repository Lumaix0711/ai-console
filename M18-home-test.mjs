// M18：主页落地页 + 会话视图重构（折叠 / 身份条 / 流式纯文本）
// [1] 静态接线 [2] vm 纯函数与折叠开关
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

console.log('[1] 主页')
t('主页样式与继续卡/列表存在', /#home\{/.test(html) && /\.home-hero\{/.test(html) && /\.home-list\{/.test(html))
t('顶栏入口改为主页', /id="clearBtn"[^>]*>主页</.test(html))
t('showHome 先清主区再读列表', /async function showHome\(\)[\s\S]{0,220}clearMain\(\)[\s\S]{0,220}\/api\/history\/list/.test(js))
t('只列根会话，子代理计数', js.includes('const roots = all.filter((x) => !x.parentID)') && js.includes("kids.get(x.id) + ' 个子代理'"))
t('继续上次取 localStorage 的 sid', js.includes("const LAST_KEY = 'ac-last-sid'") && /(?:const|let) cont = roots\.find\(\(x\) => x\.id === last\)/.test(js))
t('运行中徽标来自 /api/state', js.includes("fetch('/api/state').then((r) => r.json()).catch(() => ({ sessions: [] }))") && js.includes('running.has(x.id)'))
t('不再自动回放上次会话', !js.includes('async function hydrate') && !js.includes('HYDRATE_MAX_MSG') && js.includes('function boot() { showHome().finally(() => loadPendingPerms()) }'))
t('主页可见时丢弃所有渲染事件', /const dropRender = \(sid, pid\) => \{\s*if \(homeVisible\) return true/.test(js))
t('焦点只放行本会话与直接子代理', /const focus = pinnedSession \|\| liveFocus/.test(js) && js.includes('if (pid === focus) return false') && js.includes('dropRender(p.info.id, p.info.parentID)'))
t('主页点击委托打开会话', js.includes("main.addEventListener('click'") && js.includes("const op = e.target.closest('[data-open]')"))
t('权限事件在主页只挂徽章不建卡', /if \(homeVisible\) \{[\s\S]{0,160}从主页打开该会话处理/.test(js))

console.log('\n[2] 会话视图')
t('快照身份条样式与文案', /\.snap-bar\{/.test(html) && js.includes('历史快照</span>') && js.includes('最后一条回复在快照时尚未生成完'))
t('快照条随会话结束改状态', js.includes('快照后已继续到最新') && /st === 'idle'[\s\S]{0,300}snap-warn/.test(js))
t('装载时记录当前会话', /async function loadIntoMain\(sid\)/.test(js) && js.includes('rememberSid(sid)'))
t('主页发送直接走实时，不拉历史快照', js.includes('const fromHome = homeVisible') && js.includes('if (!S.has(j.sessionID)) ensureSession(j.sessionID, { t0: Date.now() })') && !js.includes('loadIntoMain(j.sessionID'))
t('运行中会话的回放块可被实时事件接管', js.includes('const tailSet = opts.busy ? new Set(j.messages.slice(-2)') && js.includes('for (const c of [...oldBody.children]) nb.appendChild(c)'))
t('子代理默认折叠 + caret', /\.child\.collapsed>\.c-body\{display:none\}/.test(html) && js.includes("(isChild ? ' collapsed' : '')") && js.includes('class="c-caret"'))
t('点标题折叠/展开', js.includes("rec.el.querySelector('.c-head').addEventListener('click', () => toggleKid(rec))") && /function toggleKid\(rec, force\)/.test(js))
t('setStatus 不丢折叠态', js.includes('const collapsed = rec.parentID && rec.el.classList.contains(\'collapsed\')'))
t('时间线可展开全部/定位子会话', js.includes('data-kids="${anyOpen ? \'close\' : \'open\'}"') && js.includes('data-sid="${esc(k.sid)}"') && js.includes("closest('.tl-row[data-sid]')"))
t('吸底只跟随主会话，子卡不抢滚动', /function stickBottom\(rec\)/.test(js) && js.includes('if (!isChild) stickBottom(rec)') && !js.includes('down(main)'))
t('流式只刷纯文本，停顿转 Markdown', js.includes("pre.classList.add('plain'); pre.textContent = upto") && js.includes("el.classList.remove('plain')") && html.includes('.blk.plain,.rtext.plain{white-space:pre-wrap}'))
t('旧的逐帧 Markdown 重建已删', !js.includes('function paintLiveMd'))
t('子会话 user 消息标为派活指令', js.includes("const youTag = isKid ? '派活指令' : '你发的'") && js.includes("opts.child ? '派活指令' : '你发的'"))
t('子会话不提供编辑重发', js.includes('if (!isKid) addMsgAction'))
t('toast 上移且不挡输入框', html.includes('bottom:82px') && /#toast\{[\s\S]{0,400}pointer-events:none/.test(html))
t('钉住条返回主页/实时', js.includes("$('pinBack').textContent = liveBeforePin ? '回到实时' : '回到主页'") && /if \(back\) await loadIntoMain\(back\)\s*else await showHome\(\)/.test(js))

console.log('\n[3] vm 纯函数')
class FakeCL {
  constructor() { this.s = new Set() }
  add(c) { this.s.add(c) } remove(c) { this.s.delete(c) } contains(c) { return this.s.has(c) }
  toggle(c, on) { on ? this.s.add(c) : this.s.delete(c) }
}
class FakeEl {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.innerHTML = ''; this.textContent = ''; this.className = ''; this.hidden = false; this.classList = new FakeCL(); this._qs = null }
  appendChild(el) { el.parent = this; this.children.push(el); return el }
  insertBefore(el) { this.children.push(el); return el }
  remove() {}
  querySelector(sel) { if (sel === 'button') { if (!this._qs) { this._qs = new FakeEl('button'); this._qs.addEventListener = () => {} } return this._qs } return null }
  querySelectorAll() { return [] }
  addEventListener() {}
  closest() { return null }
}
const mkEl = () => new FakeEl()
const ctx = createContext({
  document: { getElementById: mkEl, createElement: (tg) => new FakeEl(tg), querySelector: mkEl, querySelectorAll: () => [], addEventListener() {}, body: mkEl(), documentElement: mkEl(), hidden: false, title: '' },
  EventSource: class { close() {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => { fn(); return 1 }, cancelAnimationFrame() {},
  CSS: { escape: (s) => String(s) }, confirm: () => false, alert() {}, TextDecoder,
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => Promise.reject(new Error('x')), window: null, Date, Math, JSON,
})
ctx.window = ctx
try { runInContext(js, ctx, { filename: 'ui.js' }) } catch (e) { if (!/getElementById/.test(e.message)) throw e }
t('fmtAgo 刚刚/分钟/小时/天', ctx.fmtAgo(Date.now() - 12000) === '刚刚' && ctx.fmtAgo(Date.now() - 5 * 60000) === '5 分钟前' && ctx.fmtAgo(Date.now() - 3 * 3600000) === '3 小时前' && ctx.fmtAgo(Date.now() - 2 * 86400000) === '2 天前')
const ts = new Date(2026, 9, 21, 13, 5).getTime()
t('fmtClock MM-DD HH:mm', ctx.fmtClock(ts) === '10-21 13:05', ctx.fmtClock(ts))
{
  const cl = new FakeCL(); cl.add('collapsed')
  const rec = { parentID: 'p', el: { classList: cl, querySelector: () => null } }
  ctx.toggleKid(rec)
  const open = !cl.contains('collapsed')
  ctx.toggleKid(rec)
  t('toggleKid 展开/收起切两次回到原状', open && cl.contains('collapsed'))
  ctx.toggleKid(rec, false)
  t('toggleKid 指定展开', !cl.contains('collapsed'))
}

console.log(fails ? `\n${fails} 项失败 ❌` : '\n全部通过 ✅')
process.exit(fails ? 1 : 0)
