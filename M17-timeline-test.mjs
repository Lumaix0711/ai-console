// M17：子代理时间线 + context 健康度
// [1] normalize 聚合字段（真实事件驱动） [2] 前端静态接线 [3] vm 纯函数（时长/ token 格式）
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { createStore } from './lib/normalize.mjs'

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

console.log('[1] normalize 聚合')
{
  const st = createStore()
  st.apply({ type: 'session.created', properties: { info: { id: 'root', time: { created: 1000 }, model: { id: 'm1', providerID: 'p1' } } } })
  st.apply({ type: 'session.created', properties: { info: { id: 'kid', parentID: 'root', time: { created: 2000 }, model: { modelID: 'm2', providerID: 'p2' } } } })
  // 工具 part 重复上报 → 只计一次
  for (let i = 0; i < 3; i++) st.apply({ type: 'message.part.updated', properties: { part: { sessionID: 'kid', messageID: 'k1', id: 'toolA', type: 'tool', tool: 'bash' } } })
  st.apply({ type: 'message.part.updated', properties: { part: { sessionID: 'kid', messageID: 'k1', id: 'toolB', type: 'tool', tool: 'read' } } })
  // 两条 assistant 消息，最后一条是当前水位
  st.apply({ type: 'message.updated', properties: { info: { sessionID: 'kid', id: 'k1', role: 'assistant',
    tokens: { total: 50000, input: 10000, output: 200, reasoning: 100, cache: { read: 39000, write: 100 } }, time: { completed: true } } } })
  st.apply({ type: 'message.updated', properties: { info: { sessionID: 'kid', id: 'k2', role: 'assistant',
    tokens: { total: 8000, input: 3000, output: 50, reasoning: 20, cache: { read: 4900, write: 50 } }, time: { completed: false } } } })
  const sn = st.snapshot()
  const kid = sn.sessions.find((x) => x.id === 'kid')
  const root = sn.sessions.find((x) => x.id === 'root')
  t('createdAt 取上游 time.created（root/kid 都不同）', root.createdAt === 1000 && kid.createdAt === 2000)
  t('两种 model 形状都归一成 {id, providerID}', root.model?.id === 'm1' && kid.model?.id === 'm2' && kid.model?.providerID === 'p2')
  t('toolCount 按 part id 去重', kid.toolCount === 2)
  t('ctxTokens = 最新一轮 total-output-reasoning', kid.ctxTokens === 8000 - 50 - 20, String(kid.ctxTokens))
  t('lastEventAt 是数字且不早于创建', typeof kid.lastEventAt === 'number' && kid.lastEventAt >= kid.createdAt)
  // 无 tokens 的会话 ctx 为 null（不是 0，前端据此藏 gauge）
  t('无 token 时不报假 ctx', root.ctxTokens === null)
  // 全零 total 的空消息不覆盖水位
  st.apply({ type: 'message.updated', properties: { info: { sessionID: 'kid', id: 'k3', role: 'assistant',
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { completed: true } } } })
  const kid2 = st.snapshot().sessions.find((x) => x.id === 'kid')
  t('全零空消息不覆盖上下文水位', kid2.ctxTokens === 8000 - 70)
  // 上报量 = input + cache.read + cache.write（这里应是 8000）
  t('上下文水位与 total 口径一致', kid.tokens === undefined && kid.ctxTokens + 70 === 8000)
}

console.log('\n[2] 前端接线')
t('CSS 有时间线轨道 / 动态条 / ctx pill', /\.tl-track\{/.test(html) && /\.tl-bar\.on\{/.test(html) && /\.s-ctx\{/.test(html) && /\.s-ctx\.warn\{/.test(html) && /\.s-ctx\.hot\{/.test(html))
t('根卡片有 ctx pill 和时间线容器', /class="s-ctx" style="display:none"/.test(html) && /<div class="tl" hidden><\/div><div class="children">/.test(html))
t('bumpLive / scheduleTL / paintTL / paintCtx 定义存在', ['bumpLive', 'scheduleTL', 'paintTL', 'paintCtx'].every((f) => new RegExp(`function ${f}\\(`).test(js)))
t('handle 顶部对每个事件调 bumpLive', /const liveSid = p\.sessionID \|\| p\.info\?\.sessionID \|\| p\.info\?\.id \|\| p\.part\?\.sessionID[\s\S]{0,80}bumpLive\(liveSid, p\)/.test(js))
t('工具 part 去重计数', /p\.part\?\.type === 'tool'[\s\S]{0,120}toolIds\.add\(p\.part\.id\)/.test(js))
t('ctx 用 total 减 output/reasoning 计算', /total - \(Number\(t\.output\) \|\| 0\) - \(Number\(t\.reasoning\) \|\| 0\)/.test(js))
t('setStatus 刷新时间线和 ctx', /scheduleTL\(rec\.parentID \|\| rec\.sid\); paintCtx\(rec\)/.test(js))
t('子代理挂载时刷新父时间线', /scheduleTL\(parentID\)/.test(js))
t('模型列表回来时补画 ctx 和条', /for \(const r of S\.values\(\)\) \{ paintCtx\(r\); if \(!r\.parentID\) scheduleTL\(r\.sid\) \}/.test(js))
t('1s 心跳只在有子代理在跑时推进', /kids\.some\(\(k\) => k\.status !== 'idle' && k\.status !== 'error'\)\) scheduleTL\(r\.sid\)/.test(js))
t('时间线行含 时长/工具数/ctx% 与进行中动画', /fmtDur\(b - k\.t0\)/.test(js) && /' 工具'/.test(js) && /'ctx ' \+ cp \+ '%'/.test(js) && /tl-bar\$\{run \? ' on' : ''\}/.test(js))

console.log('\n[3] vm 纯函数')
class FakeCL { constructor() { this.s = new Set() } add(c) { this.s.add(c) } remove(c) { this.s.delete(c) } contains(c) { return this.s.has(c) } toggle(c, on) { on ? this.s.add(c) : this.s.delete(c) } }
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
t('fmtDur 秒/分/时', ctx.fmtDur(95000) === '1m35s' && ctx.fmtDur(5000) === '5s' && ctx.fmtDur(3900000) === '1h05m', `${ctx.fmtDur(95000)}|${ctx.fmtDur(5000)}|${ctx.fmtDur(3900000)}`)
t('fmtTok k/M', ctx.fmtTok(87000) === '87k' && ctx.fmtTok(1500000) === '1.5M' && ctx.fmtTok(999) === '999', `${ctx.fmtTok(87000)}|${ctx.fmtTok(1500000)}|${ctx.fmtTok(999)}`)
t('ctxPct：无水位返回 null（藏 gauge）', ctx.ctxPct({ ctx: 0, modelID: 'x' }) === null)
t('modelIdOf 兼容字符串/两种对象', ctx.modelIdOf('abc') === 'abc' && ctx.modelIdOf({ id: 'i' }) === 'i' && ctx.modelIdOf({ modelID: 'm' }) === 'm')

console.log(fails ? `\n${fails} 项失败 ❌` : '\n全部通过 ✅')
process.exit(fails ? 1 : 0)
