// M16：会话撤回 / 分叉 / 压缩（M16）
// 上游语义（2026-10 实测，opencode 1.19）：
//   POST /session/:id/revert {messageID}  → 把 assistant 归一到前一条 user 消息：
//       还原文件改动（单向：unrevert 不会把文件改回来），消息仅打标记不删除；
//       之后发新消息 = 自动提交回退，旧分支从会话里丢弃。
//   POST /session/:id/unrevert            → 清除标记（消息仍在）
//   POST /session/:id/fork {messageID?}   → 无参复制整段；带参=只复制该消息之前的（排他）
//   POST /session/:id/summarize {providerID, modelID} → 追加 compaction 用户消息 + 摘要 assistant 消息
// 本测试：静态接线 + vm 跑 paintRevert 验证压暗/横幅 + 对本地服务做路由校验（不碰真实会话）。
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const srv = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8')
const norm = readFileSync(new URL('./lib/normalize.mjs', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

// ── 1. 静态接线 ─────────────────────────────
console.log('\n[1] 静态接线')
t('前端有会话操作三按钮（data-act revert/fork/summ）',
  /class="s-acts"><button type="button" data-act="revert"/.test(html) &&
  /data-act="fork"/.test(html) && /data-act="summ"/.test(html))
t('sessAct / paintRevert / postJSON 定义存在',
  /async function sessAct\(/.test(js) && /function paintRevert\(/.test(js) && /async function postJSON\(/.test(js))
t('ensureSession 把 info.revert 记到 rec 上', /revert: info\.revert \|\| null/.test(js))
t('session.updated 处理 revert 变化（全量信任）', /p\.info\.revert \|\| null[\s\S]{0,160}paintRevert\(rec\)/.test(js))
t('ensureMsg 给实时消息打 data-mid', /el\.dataset\.mid = mid/.test(js))
t('回退状态下新消息立刻压暗（ensureMsg 尾部 paintRevert）', /if \(rec\.revert\) paintRevert\(rec\)/.test(js))
t('回退横幅含「恢复消息」按钮', /已回退[\s\S]{0,120}恢复消息/.test(js))
t('发送新消息时截断回退段（上游自动提交回退）', /function truncateReverted\(/.test(js) && /if \(rr\) truncateReverted\(rr\)/.test(js))
t('乐观气泡有 data-opt，真实消息到达时摘掉', /el\.dataset\.opt = '1'/.test(js) && /querySelectorAll\('\.msg\[data-opt\]'\)/.test(js))
t('处理 message.removed（上游删消息时同步摘 DOM）', /ev\.type === 'message\.removed'/.test(js) && /rec\.msgs\.delete\(mid\)/.test(js))
t('loadIntoMain 从 /api/state 补 revert 并重绘', /fetch\('\/api\/state'\)[\s\S]{0,2400}rec\.revert = \(live && live\.revert\) \|\| null[\s\S]{0,80}paintRevert\(rec\)/.test(js))
t('实时渲染有 compaction 分支', /type === 'compaction'[\s\S]{0,160}cmp-note/.test(js))
t('回放渲染有 compaction 分支', /else if \(p\.type === 'compaction'\)[\s\S]{0,80}cmp-note/.test(js))
t('CSS：.revd 压暗 + .rev-bar 横幅 + .cmp-note', /\.msg\.revd,.rp\.revd/.test(html) && /\.rev-bar\{/.test(html) && /\.cmp-note\{/.test(html))
t('server 四条路由齐全', ['/api/revert', '/api/unrevert', '/api/fork', '/api/summarize'].every((r) => srv.includes(`p === '${r}'`)))
t('revert 无 messageID 时自动找最后一条正文用户消息', /reverse\(\)\.find\(/.test(srv) && /type === 'text'/.test(srv))
t('summarize 用会话自己的 providerID/modelID（注意会话 model 字段是 id 不是 modelID）',
  /sess\.model \|\| \{\}/.test(srv) && /model\.id \|\| model\.modelID/.test(srv) && /providerID/.test(srv))
t('fork 无参不带 body（=整段复制）', /if \(pl\.messageID\) init\.body/.test(srv))
t('normalize 记录 revert（created/updated/snapshot）',
  /revert: info\.revert \?\? null/.test(norm) && /s\.revert = info\.revert \?\? null/.test(norm) && /revert: s\.revert \?\? null/.test(norm))

// ── 2. vm：paintRevert 压暗与横幅 ─────────────────
console.log('\n[2] paintRevert 行为（vm）')
class FakeCL {
  constructor(el) { this.el = el; this.set2 = new Set() }
  add(c) { this.set2.add(c) }
  remove(c) { this.set2.delete(c) }
  contains(c) { return this.set2.has(c) }
  toggle(c, on) { on ? this.set2.add(c) : this.set2.delete(c) }
}
class FakeEl {
  constructor(tag = 'div') {
    this.tag = tag
    this.children = []
    this.parent = null
    this.dataset = {}
    this.style = {}
    this.innerHTML = ''
    this.textContent = ''
    this.className = ''
    this.hidden = false
    this.classList = new FakeCL(this)
    this._qs = null
  }
  appendChild(el) { el.parent = this; this.children.push(el); return el }
  insertBefore(el, ref) {
    el.parent = this
    const i = this.children.indexOf(ref)
    if (i >= 0) this.children.splice(i, 0, el); else this.children.push(el)
    return el
  }
  remove() {
    if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1) }
    this.parent = null
  }
  querySelector(sel) {
    if (sel === 'button') {
      if (!this._qs) { this._qs = new FakeEl('button'); this._qs.onclick = null; this._qs.disabled = false }
      return this._qs
    }
    return null
  }
  querySelectorAll(sel) {
    if (sel === '.revd') return this.children.filter((c) => c.classList.contains('revd'))
    return []
  }
  addEventListener() {}
  closest() { return null }
}
const mkEl = () => new FakeEl()
const documentStub = {
  getElementById: mkEl, createElement: (tg) => new FakeEl(tg), querySelector: mkEl,
  querySelectorAll: () => [], addEventListener() {}, body: mkEl(), documentElement: mkEl(), title: '',
}
const ctx = createContext({
  document: documentStub,
  EventSource: class { close() {} }, console, setTimeout, clearTimeout, setInterval, clearInterval,
  CSS: { escape: (s) => String(s) }, confirm: () => false, alert() {}, TextDecoder,
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => Promise.reject(new Error('x')), window: null, Date, Math, JSON,
})
ctx.window = ctx
try { runInContext(js, ctx, { filename: 'ui.js' }) } catch (e) { if (!/getElementById/.test(e.message)) throw e }

t('paintRevert 可调用', typeof ctx.paintRevert === 'function')

const body = new FakeEl()
const rec = { sid: 'ses_m16', bodyEl: body, el: new FakeEl(), revert: null, revBar: null }
const mkMsg = (mid) => { const el = new FakeEl(); el.dataset.mid = mid; body.appendChild(el); return el }
const m1 = mkMsg('msg_a'), m2 = mkMsg('msg_b'), m3 = mkMsg('msg_c')
rec.el.appendChild(body)

rec.revert = { messageID: 'msg_b' }
ctx.paintRevert(rec)
t('目标消息之前的旧消息不压暗', !m1.classList.contains('revd'))
t('目标消息本身压暗', m2.classList.contains('revd'))
t('目标之后的消息压暗', m3.classList.contains('revd'))
t('横幅挂在 body 前面', rec.el.children[0] !== body && rec.revBar && rec.el.children.includes(rec.revBar))
t('横幅位置 = bodyEl 之前', rec.el.children.indexOf(rec.revBar) === rec.el.children.indexOf(body) - 1)

rec.revert = null
ctx.paintRevert(rec)
t('清除回退后压暗全部撤掉', !m1.classList.contains('revd') && !m2.classList.contains('revd') && !m3.classList.contains('revd'))
t('清除回退后横幅移除', !rec.el.children.includes(rec.revBar) || rec.revBar === null)

// ── 3. 本地服务路由校验（不碰真实会话）─────────────
console.log('\n[3] 路由校验（localhost:4090）')
const P = 'http://localhost:4090'
const post = async (path, body) => {
  const r = await fetch(P + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
for (const route of ['/api/revert', '/api/unrevert', '/api/fork', '/api/summarize']) {
  try {
    const a = await post(route, {})
    t(`${route} 缺参 → 400`, a.status === 400 && /sessionID/.test(a.j.error), JSON.stringify(a))
    const b = await post(route, { sessionID: 'ses_nonexistent_m16' })
    t(`${route} 不存在会话 → 502/404 错误透出`, b.status >= 502 || b.j.error, JSON.stringify(b))
  } catch (e) {
    t(`${route} 连通性`, false, e.message)
  }
}

console.log(fails ? `\n  ${fails} 项失败` : '\n  全部通过')
process.exit(fails ? 1 : 0)
