// M12：术语卡片（选中词 → 临时会话解释）
// 交互模型：用户自己选词（拖选/双击）→ 浮出「解释这个词」→ 点开侧边卡片 → 后端临时会话解释。
// 不依赖 AI 主动标记、不干扰阅读（Obendorf links-on-demand）。
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
const mk = () => ({
  innerHTML: '', textContent: '', value: '', dataset: {}, style: {}, hidden: false,
  classList: { add() {}, remove() {}, contains() { return false }, toggle() {} },
  appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return mk() }, querySelectorAll() { return [] }, closest() { return null },
})
const ctx = createContext({
  document: { getElementById: mk, createElement: mk, querySelector: mk, querySelectorAll: () => [], addEventListener() {}, body: mk(), documentElement: mk() },
  EventSource: class { close() {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: (s) => String(s) }, confirm: () => false, alert() {}, TextDecoder,
  fetch: () => Promise.reject(new Error('x')), window: null,
})
ctx.window = ctx
try { runInContext(js, ctx, { filename: 'ui.js' }) } catch (e) { if (!/getElementById/.test(e.message)) throw e }
const md = ctx.md
if (typeof md !== 'function') { console.error('❌ md 没定义'); process.exit(1) }

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

console.log('【选词模型（不靠 AI 主动标记）】')
t('★ 不再解析 {{词}} 标记', !js.includes("\\{\\{([^{}\\n]{1,40})\\}\\}") && !md('这是 {{RAM}}').includes('class="term"'))
t('不再有 .term 自动标记节点', !html.includes('class="term"'))
t('mouseup 选词触发浮层', js.includes("document.addEventListener('mouseup'") && js.includes('showSelPop'))
t('dblclick 双击也能触发', js.includes("document.addEventListener('dblclick'"))
t('浮层按钮文案带所选词', js.includes("'✦ 解释「' + word + '」'"))
t('只有正文里的选词才响应', js.includes(".msg-body, .rp-txt, .rtext, .md, .tc-body"))
t('选词长度上限 40 字', /text\.length > 40/.test(js))
t('点别处收起浮层', js.includes('mousedown') && js.includes('hideSelPop()'))

console.log('【上下文提取（结合句子而非通用词典）】')
t('上下文取所在段落', js.includes("'p,li,h3,h4,h5,h6,td,blockquote'"))
t('上下文截断 200 字', js.includes('.slice(0, 200)'))
t('走 /api/explain 带上下文', js.includes("fetch('/api/explain'") && js.includes('context: ctx'))

console.log('【侧边卡片】')
t('卡片容器齐全', html.includes('id="termCard"') && html.includes('id="tcTitle"') && html.includes('id="tcCtx"') && html.includes('id="tcBody"'))
t('有追问输入框', html.includes('id="tcFollow"'))
t('有钉住按钮', html.includes('id="tcPin"'))
t('有加载动画', html.includes('.tc-loading::before'))
t('钉住时 Esc 不关', /Escape[\s\S]{0,120}pinned/.test(js))
t('追问走同一接口', js.includes('askTerm(termState.term, termState.ctx, q)'))

console.log('')
console.log(fails === 0 ? 'M12 全部通过 ✅' : `${fails} 项失败 ❌`)
process.exit(fails ? 1 : 0)