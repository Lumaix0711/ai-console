#!/usr/bin/env node
// M4 复验：拿已保存的 SSE 事件流离线校验各项能力
// 用法: node M4-verify.mjs
import { readFileSync } from 'node:fs'

const ev = JSON.parse(readFileSync('/tmp/opencode/m4-events.json', 'utf8'))
let fails = 0
const log = (...a) => console.log(...a)
const check = (n, c, d = '') => { c ? log(`  [PASS] ${n}${d ? '  ' + d : ''}`) : (fails++, log(`  [FAIL] ${n}  ${d}`)) }

log('\n══════ M4 离线复验（事件流共 ' + ev.length + ' 个）══════\n')

// ── 1. 自动分裂 ────────────────────────────────────────
const created = ev.filter((e) => e.type === 'session.created').map((e) => e.properties.info)
const roots = created.filter((s) => !s.parentID)
const kids = created.filter((s) => s.parentID)
log('【1】自动分裂')
log(`  根会话 ${roots.length} 个，子会话 ${kids.length} 个`)
for (const s of kids) log(`    子: ${(s.title || '').replace(/\s*\(@[^)]*\)\s*$/, '').slice(0, 34).padEnd(36)} agent=${s.agent}`)
check('根会话存在', roots.length >= 1, roots[0]?.id?.slice(0, 22))
check('★ 子会话带 parentID 挂在根下', kids.length >= 3, `${kids.length} 个子会话`)
check('每个子会话都知道自己的父', kids.every((k) => k.parentID === roots[0]?.id))
check('子会话带 agent 标识', kids.every((k) => !!k.agent), [...new Set(kids.map((k) => k.agent))].join(','))

// ── 2. 思考过程 ────────────────────────────────────────
log('\n【2】思考过程（思考面板数据源）')
const rsnUpd = ev.filter((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'reasoning')
const rsnDone = rsnUpd.filter((e) => (e.properties.part.text || '').length > 0)
const rsnWithEnd = rsnUpd.filter((e) => e.properties.part.time?.end)
const deltas = ev.filter((e) => e.type === 'message.part.delta')
const rsnDelta = deltas.filter((e) => e.properties?.partID && rsnUpd.some((r) => r.properties.part.id === e.properties.partID))
const totalChars = rsnDone.reduce((n, e) => n + e.properties.part.text.length, 0)
log(`  reasoning updated ${rsnUpd.length} 个，其中带完整文本 ${rsnDone.length} 个`)
log(`  带 time.end（可算耗时）${rsnWithEnd.length} 个`)
log(`  delta 事件 ${deltas.length} 个，其中喂给 reasoning 的 ${rsnDelta.length} 个`)
log(`  思考文本总量 ${totalChars} 字`)
if (rsnDone[0]) {
  const t = rsnDone[0].properties.part.time
  log(`  样例耗时: ${((t.end - t.start) / 1000).toFixed(1)}s  文本前60字: "${rsnDone[0].properties.part.text.slice(0, 60)}…"`)
}
check('★ 有思考文本', totalChars > 1000, `${totalChars} 字`)
check('★ 有可显示的思考耗时', rsnWithEnd.length > 0, rsnWithEnd.length + ' 段')
check('★ 思考文本有流式 delta（可实时显示）', rsnDelta.length > 0, `${rsnDelta.length} 个 delta`)

// ── 3. 状态灯 ──────────────────────────────────────────
log('\n【3】状态灯')
const st = ev.filter((e) => e.type === 'session.status')
const types = [...new Set(st.map((e) => e.properties?.status?.type))]
const idleEv = ev.filter((e) => e.type === 'session.idle')
log(`  session.status 事件 ${st.length} 个，状态类型: ${types.join(', ')}`)
check('★ 有 busy 状态', types.includes('busy'))
check('★ 有 idle 状态', types.includes('idle') || idleEv.length > 0)

// ── 4. 完成判定 ────────────────────────────────────────
log('\n【4】完成判定（必须靠 time.completed）')
const mu = ev.filter((e) => e.type === 'message.updated' && e.properties?.info?.time?.completed)
log(`  带 time.completed 的 message.updated ${mu.length} 个`)
check('★ 完成判定可用', mu.length > 0, `${mu.length} 条完成消息`)

// ── 5. 工具调用 ────────────────────────────────────────
log('\n【5】工具调用显示')
const tools = ev.filter((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'tool')
const tnames = [...new Set(tools.map((e) => e.properties.part.tool))]
log(`  工具 part ${tools.length} 个，类型: ${tnames.join(', ')}`)
const statuses = [...new Set(tools.map((e) => e.properties.part.state?.status))]
log(`  状态: ${statuses.join(', ')}`)
check('有工具调用可显示', tools.length > 0, `${tools.length} 个 / ${tnames.join(',')}`)

// ── 6. 正文 ────────────────────────────────────────────
log('\n【6】正文输出')
const texts = ev.filter((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'text')
const tChars = texts.reduce((n, e) => n + (e.properties.part.text || '').length, 0)
log(`  text part ${texts.length} 个，总量 ${tChars} 字`)
check('有正文输出', tChars > 500, `${tChars} 字`)

// ── 7. 按会话汇总 ──────────────────────────────────────
log('\n【7】按会话汇总（每个卡片的数据）')
const byS = {}
for (const e of ev) {
  const sid = e.properties?.part?.sessionID || e.properties?.info?.sessionID || e.properties?.sessionID
  if (!sid) continue
  byS[sid] = byS[sid] || { rsn: 0, txt: 0, tools: 0, done: 0, status: '?' }
  const p = e.properties?.part
  if (p?.type === 'reasoning') byS[sid].rsn += (p.text || '').length
  if (p?.type === 'text') byS[sid].txt += (p.text || '').length
  if (p?.type === 'tool') byS[sid].tools++
  if (e.type === 'message.updated' && e.properties?.info?.time?.completed) byS[sid].done++
  if (e.type === 'session.status') byS[sid].status = e.properties.status?.type
}
for (const [sid, v] of Object.entries(byS)) {
  const kind = kids.some((k) => k.id === sid) ? '子' : (roots.some((r) => r.id === sid) ? '根' : '?')
  log(`  ${kind} ${sid.slice(0, 20)}… 思考${String(v.rsn).padStart(6)}字 正文${String(v.txt).padStart(6)}字 工具${String(v.tools).padStart(3)} 完成${String(v.done).padStart(2)} ${v.status}`)
}
check('每个会话都有可展示的数据', Object.keys(byS).length >= 4, `${Object.keys(byS).length} 个会话`)

log('\n' + '═'.repeat(52))
log(fails === 0 ? 'M4 全部通过 ✅' : `${fails} 项失败 ❌`)
log('═'.repeat(52))
process.exit(fails === 0 ? 0 : 1)
