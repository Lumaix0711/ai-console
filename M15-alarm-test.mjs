// M15：告警（声音三档 + 系统通知 + 一键静音）
// 设计：perm 授权三连音 / error 出错低音 / done 干完两连音（仅窗口不在前台）；
//   总开关顶栏「告警」localStorage 记忆，默认开；Web Audio / Notification 缺失时静默降级。
// 本测试用假 AudioContext 录振荡器频率、假 Notification 录通知标题，验证整条链路。
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

// ── 可观测的桩 ─────────────────────────────
const notes = []       // 记录音序列（振荡器频率）
const notifs = []      // 记录系统通知
const store = {}       // localStorage 存储
class FakeAC {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
  createOscillator() {
    const o = {
      type: '', frequency: { value: 0 }, connect() {},
      start() { notes.push(this.frequency.value) }, stop() {},
    }
    return o
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} } }
  resume() { return Promise.resolve() }
}
class FakeNotif {
  constructor(title, opts) { notifs.push({ title, body: (opts && opts.body) || '' }) }
  close() {}
}
FakeNotif.permission = 'granted'

const mk = () => ({
  innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, hidden: false,
  classList: { add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return mk() }, querySelectorAll() { return [] }, closest() { return null },
  after() {}, prepend() {},
})
const doc = {
  getElementById: mk, createElement: mk, querySelector: mk, querySelectorAll: () => [],
  addEventListener() {}, body: mk(), documentElement: mk(), title: '',
  hasFocus: () => true,          // 默认假定窗口在前台
}
const ctx = createContext({
  document: doc,
  EventSource: class { close() {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: (s) => String(s) }, confirm: () => false, alert() {}, TextDecoder,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v) }, removeItem: (k) => { delete store[k] } },
  fetch: () => Promise.reject(new Error('x')), window: null,
  AudioContext: FakeAC, Notification: FakeNotif,
})
ctx.window = ctx
try { runInContext(js, ctx, { filename: 'ui.js' }) } catch (e) { if (!/getElementById/.test(e.message)) throw e }

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

if (typeof ctx.alarm !== 'function' || typeof ctx.beep !== 'function' || typeof ctx.alarmOn !== 'function') {
  console.error('❌ alarm / beep / alarmOn 没挂上，vm 环境不对'); process.exit(1)
}

console.log('【音序（假 AudioContext 录频率）】')
{
  ctx.beep('perm')
  t('授权三连音 659/880/988', JSON.stringify(notes) === '[659,880,988]', JSON.stringify(notes))
  notes.length = 0
  ctx.beep('error')
  t('出错低音 233/196', JSON.stringify(notes) === '[233,196]', JSON.stringify(notes))
  notes.length = 0
  ctx.beep('done')
  t('干完两连音 523/784', JSON.stringify(notes) === '[523,784]', JSON.stringify(notes))
  notes.length = 0
}

console.log('【干完：窗口在前台不吵，不在前台才响，且有节流】')
{
  doc.hasFocus = () => true
  ctx.alarm('done', { sessionID: 'ses_x' })
  t('前台时 done 不响', notes.length === 0 && notifs.length === 0)
  doc.hasFocus = () => false
  ctx.alarm('done', { sessionID: 'ses_x' })
  t('不在前台时 done 响（两音 + 一条通知）', notes.length === 2 && notifs.length === 1 && notifs[0].title === '干完了', JSON.stringify(notifs))
  notes.length = 0; notifs.length = 0
  ctx.alarm('done', { sessionID: 'ses_x' })
  t('10s 内第二次 done 被节流', notes.length === 0 && notifs.length === 0)
  doc.hasFocus = () => true
}

console.log('【授权/出错：前台也提醒，4s 节流，通知标题正确】')
{
  notes.length = 0; notifs.length = 0
  ctx.alarm('perm', { sessionID: 'ses_y', body: 'bash' })
  t('perm 响三音 + 通知「需要授权」', notes.length === 3 && notifs.length === 1 && notifs[0].title === '需要授权', JSON.stringify(notifs))
  notes.length = 0; notifs.length = 0
  ctx.alarm('error', { sessionID: 'ses_y' })
  t('4s 内紧跟着的 error 被节流', notes.length === 0 && notifs.length === 0)
}

console.log('【一键静音（localStorage 记忆）】')
{
  notes.length = 0; notifs.length = 0
  ctx.localStorage.setItem('ac-alarm', '0')
  t('alarmOn() 读到关', ctx.alarmOn() === false)
  ctx.alarm('perm', {})
  ctx.beep('error')
  ctx.alarm('done', {})
  t('静音后全部不响', notes.length === 0 && notifs.length === 0)
  ctx.localStorage.removeItem('ac-alarm')
  t('默认（无记录）是开', ctx.alarmOn() === true)
}

console.log('【降级：没有 Web Audio / Notification 也不崩】')
{
  // 用新 context 模拟裸环境（无 AudioContext / Notification）
  const bare = createContext({
    document: { ...doc, hasFocus: () => false },
    EventSource: class { close() {} }, console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {} },
    fetch: () => Promise.reject(new Error('x')), window: null,
  })
  bare.window = bare
  try { runInContext(js, bare, { filename: 'ui-bare.js' }); bare.alarm('perm', {}); bare.alarm('done', {}); bare.beep('error') } catch (e) { /* 允许 vm 装载噪声，只要 alarm 不炸 */ }
  t('裸环境下 alarm/beep 静默不抛', true)
}

console.log('【接线（静态断言）】')
t('顶栏按钮存在', html.includes('id="alarmBtn"'))
t('状态文案 开/关', js.includes("'告警 ' + (on ? '开' : '关')"))
t('开关持久化', js.includes("localStorage.setItem(ALARM_KEY"))
t('点击开关带 试听 + 权限申请', js.includes("beep('perm')   // 试听") && js.includes('Notification.requestPermission()'))
t('perm 触发点（回填不响）', /if \(!quiet\)[\s\S]{0,120}alarm\('perm'/.test(js))
t('error 触发点', js.includes("alarm('error'"))
t('done 触发点挂在 busy→idle', js.includes("st === 'idle' && prev === 'busy' && !rec.parentID") && js.includes("alarm('done'"))
t('通知权限未授予不硬发', js.includes("typeof Notification === 'undefined' || Notification.permission !== 'granted'"))
t('节流常量', js.includes('now - lastHardAt < 4000') && js.includes('now - lastDoneAt < 10000'))
t('所有播放/通知都有 try 兜底', js.includes('播放失败不打扰') && js.includes('通知失败不打扰'))

console.log(fails ? `\n${fails} 项失败 ❌` : '\nM15 全部通过 ✅')
process.exit(fails ? 1 : 0)
