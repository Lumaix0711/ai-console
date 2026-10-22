// M10：edit/write diff 视图的纯函数单测（lineDiff / diffStats / toolExtraHtml）
// 数据源实测：edit.input={filePath,oldString,newString}、write.input={filePath,content}
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
const { lineDiff, diffStats, toolExtraHtml } = ctx
if (typeof lineDiff !== 'function' || typeof toolExtraHtml !== 'function') { console.error('❌ lineDiff / toolExtraHtml 没定义'); process.exit(1) }

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))
const types = (rows) => rows.map((r) => r.t).join('')

console.log('【lineDiff 行级 diff】')

// 1. 完全相同 → 全是上下文
{
  const r = lineDiff('a\nb\nc', 'a\nb\nc')
  t('相同输入全为上下文行', types(r) === '   ' && diffStats(r).add === 0 && diffStats(r).del === 0)
}

// 2. 纯新增
{
  const r = lineDiff('a\nc', 'a\nb\nc')
  t('纯新增一行', types(r) === ' + ' && diffStats(r).add === 1 && diffStats(r).del === 0, types(r))
}

// 3. 纯删除
{
  const r = lineDiff('a\nb\nc', 'a\nc')
  t('纯删除一行', types(r) === ' - ' && diffStats(r).del === 1 && diffStats(r).add === 0, types(r))
}

// 4. 替换一行 = 一删一增
{
  const r = lineDiff('a\nold\nc', 'a\nnew\nc')
  const s = diffStats(r)
  t('替换一行 = 1 删 1 增', s.add === 1 && s.del === 1, JSON.stringify(s))
  t('替换行内容正确', r.some((x) => x.t === '-' && x.s === 'old') && r.some((x) => x.t === '+' && x.s === 'new'))
}

// 5. 多个 hunk（两处不相邻改动）
{
  const r = lineDiff('a\nx1\nb\nc\nd\nx2\ne', 'a\ny1\nb\nc\nd\ny2\ne')
  const s = diffStats(r)
  t('多个 hunk 统计正确', s.add === 2 && s.del === 2, JSON.stringify(s))
}

// 6. 大输入降级（前后缀裁剪），结果仍正确且不含 NaN
{
  const A = Array.from({ length: 400 }, (_, i) => 'line' + i).join('\n')
  const B = A.replace('line200', 'CHANGED')
  const r = lineDiff(A, B)
  const s = diffStats(r)
  t('大输入降级路径（400×400>9 万）统计正确', s.add === 1 && s.del === 1, JSON.stringify(s))
}

// 7. 空串 ↔ 非空（''.split('\n')=['']，是"一个空行"，所以是 删空行+增两行）
{
  const r = lineDiff('', 'a\nb')
  const s = diffStats(r)
  t('空 → 非空 = 2 增 1 删（空行）', s.add === 2 && s.del === 1, JSON.stringify(s))
}

console.log('【toolExtraHtml 渲染】')

// 8. edit completed → diff 卡含徽章与 +/- 行
{
  const h = toolExtraHtml({ tool: 'edit', state: { status: 'completed', input: { filePath: '/a/b/c.mjs', oldString: 'x = 1\ny = 2', newString: 'x = 1\ny = 3' } } })
  t('edit 产出 diff 卡', h.includes('class="tdiff"') && h.includes('b/c.mjs'))
  t('diff 卡徽章 +1 −1', h.includes('<b class="add">+1</b>') && h.includes('<b class="del">−1</b>'), h.slice(0, 200))
  t('diff 卡含删除/新增行', h.includes('dl del') && h.includes('dl add'))
}

// 9. edit 无变化 → 不出卡
t('edit 无变化不出卡', toolExtraHtml({ tool: 'edit', state: { status: 'completed', input: { filePath: 'f', oldString: 'a', newString: 'a' } } }) === '')

// 10. write → 全量写入卡 + 行数
{
  const h = toolExtraHtml({ tool: 'write', state: { status: 'completed', input: { filePath: '/x/y.md', content: 'l1\nl2\nl3' } } })
  t('write 产出全量写入卡', h.includes('class="tdiff"') && h.includes('<b class="add">+3</b>'))
}

// 11. write 超 12 行 → 有展开折叠
{
  const h = toolExtraHtml({ tool: 'write', state: { status: 'completed', input: { filePath: 'f', content: Array.from({ length: 20 }, (_, i) => 'L' + i).join('\n') } } })
  t('write 超 12 行带展开折叠', h.includes('tdiff-more') && h.includes('余下 8 行'))
}

// 12. 失败工具 → 错误卡
{
  const h = toolExtraHtml({ tool: 'bash', state: { status: 'error', output: 'command not found: foo' } })
  t('失败工具出错误卡', h.includes('class="terr"') && h.includes('command not found: foo') && h.includes('复制错误'))
}

// 13. XSS：diff 内容里的 HTML 必须转义
{
  const h = toolExtraHtml({ tool: 'edit', state: { status: 'completed', input: { filePath: 'f', oldString: '<div>a</div>', newString: '<script>alert(1)</script>' } } })
  t('★ diff 内容 HTML 转义', h.includes('&lt;script&gt;') && !h.includes('<script>alert(1)</script>'))
}

// 14. running / pending 不出卡
t('running 不出卡', toolExtraHtml({ tool: 'edit', state: { status: 'running', input: { filePath: 'f', oldString: 'a', newString: 'b' } } }) === '')

// 15. 非 edit/write 的 completed → 空
t('bash completed 不出 diff 卡', toolExtraHtml({ tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } }) === '')

console.log('')
console.log(fails === 0 ? 'M10 全部通过 ✅' : `${fails} 项失败 ❌`)
process.exit(fails ? 1 : 0)
