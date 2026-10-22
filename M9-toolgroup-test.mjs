// M9：工具折叠纯函数 planToolGroups 的单元测试
// 规则（用户拍板）：
//   - 连续可折叠的 .msg 攒成一组，组内工具总数 ≥3 才折（1-2 个散工具保持平铺）
//   - fold=false（正文 / 派活 / 失败 / 运行中 / task）打断连续段
//   - 摘要统计 byTool 与总耗时 ms；firstPid = 组首工具 pid（展开状态记忆的 key）
// 参考：opencode packages/session-ui/src/components/message-part.tsx 的 groupParts
// 实测结构：每个 .msg 只装一个工具，所以分组单位是整个 .msg，不是 blk。
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
const plan = ctx.planToolGroups
if (typeof plan !== 'function') { console.error('❌ planToolGroups 没定义'); process.exit(1) }

// 造一条可折叠的 .msg：n 个工具、byTool 聚合、耗时 ms
let n = 0
const F = (tool = 'bash', cnt = 1, ms = 1000) => ({ fold: true, pid: 'p' + (++n), n: cnt, byTool: { [tool]: cnt }, ms })
const B = () => ({ fold: false, pid: 'p' + (++n) })   // 正文/派活/失败/运行中 → 打断

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

console.log('【planToolGroups 分组规则】')

// 1. 2 个可折叠（各 1 工具）→ 总工具数 2 < 3 → 不成组
t('2 个可折叠（共 2 工具）不成组（阈值 ≥3）', plan([F(), F()]).length === 0)

// 2. 3 个可折叠 → 1 组
{
  const g = plan([F(), F(), F()])
  t('3 个可折叠（共 3 工具）成 1 组', g.length === 1 && g[0].count === 3 && g[0].start === 0 && g[0].end === 2, JSON.stringify(g))
}

// 3. 打断：F F B F F F → 只有后 3 个成组
{
  const g = plan([F(), F(), B(), F(), F(), F()])
  t('正文/派活/失败打断连续段', g.length === 1 && g[0].start === 3 && g[0].count === 3, JSON.stringify(g))
}

// 4. 打断后只剩 2 个 → 不成组
t('打断后只剩 2 个不成组', plan([F(), F(), B(), F(), F()]).length === 0)

// 5. 两段各 ≥3 → 2 组
{
  const g = plan([F(), F(), F(), B(), F(), F(), F()])
  t('两段各 ≥3 成 2 组', g.length === 2 && g[0].count === 3 && g[1].count === 3, JSON.stringify(g))
}

// 6. byTool 跨消息聚合 + ms 求和
{
  const g = plan([F('bash', 1, 1000), F('bash', 1, 2000), F('read', 1, 500)])
  t('byTool 跨消息聚合正确', g.length === 1 && g[0].byTool.bash === 2 && g[0].byTool.read === 1, JSON.stringify(g[0]?.byTool))
  t('ms 求和正确', g.length === 1 && g[0].ms === 3500, String(g[0]?.ms))
}

// 7. 单条消息里多工具（n=3）→ 工具总数够 3，一条也成组
{
  const g = plan([F('bash', 3, 900)])
  t('单条消息含 3 工具也成组（按工具数计）', g.length === 1 && g[0].count === 3, JSON.stringify(g))
}

// 8. firstPid = 组首 .msg 的 pid（展开状态记忆的 key）
{
  const seq = [F(), F(), F()]
  const g = plan(seq)
  t('firstPid = 组首 .msg 的 pid', g.length === 1 && g[0].firstPid === seq[0].pid)
}

// 9. 边界：恰好 3 个在末尾
{
  const g = plan([B(), F(), F(), F()])
  t('末尾恰好 3 个成组', g.length === 1 && g[0].start === 1 && g[0].end === 3)
}

// 10. 空序列 / 全打断 → 空
t('空序列返回空', plan([]).length === 0)
t('全打断返回空', plan([B(), B()]).length === 0)

// 11. 自定义 min=2（阈值参数化，证明 ≥3 是配置而不是巧合）
t('min=2 时 2 个即成组', plan([F(), F()], 2).length === 1)

// 12. 混合：1 工具 + 2 工具 = 3 → 成组（按工具总数，不按消息条数）
{
  const g = plan([F('bash', 1), F('read', 2)])
  t('1+2 工具 = 3 成组（按工具总数计）', g.length === 1 && g[0].count === 3, JSON.stringify(g))
}

console.log('')
console.log(fails === 0 ? 'M9 全部通过 ✅' : `${fails} 项失败 ❌`)
process.exit(fails ? 1 : 0)
