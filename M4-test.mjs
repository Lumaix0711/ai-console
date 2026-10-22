#!/usr/bin/env node
// M4 验证：模拟浏览器，检验自动分裂 / 思考面板 / 状态灯
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { writeFileSync } from 'node:fs'

const UI = 'http://127.0.0.1:4090'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(...a)
let fails = 0
const check = (n, c, d = '') => { c ? log(`  [PASS] ${n}${d ? '  ' + d : ''}`) : (fails++, log(`  [FAIL] ${n}  ${d}`)) }

async function waitForPort(p, t = 40000) {
  const end = Date.now() + t
  while (Date.now() < end) {
    const up = await new Promise(r => { const s = connect({ port: p, host: '127.0.0.1' }); s.on('connect', () => { s.destroy(); r(true) }); s.on('error', () => r(false)) })
    if (up) return true; await sleep(400)
  }
  return false
}

// 确保服务在跑
if (!await waitForPort(4090, 8000)) { log('  服务没起，先启动 systemd'); spawn('systemctl', ['--user', 'restart', 'aiconsole.service'], { stdio: 'ignore' }); await waitForPort(4090, 60000) }

// ── 抓 SSE ─────────────────────────────────────────────
const log_ = []
const es = await fetch(`${UI}/api/stream`, { headers: { accept: 'text/event-stream' } })
const reader = es.body.getReader(), dec = new TextDecoder()
let buf = ''
;(async () => { try { while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const ls = buf.split('\n'); buf = ls.pop() || ''; for (const l of ls) { if (!l.startsWith('data:')) continue; try { log_.push(JSON.parse(l.slice(5).trim())) } catch {} } } } catch {} })()
await sleep(1500)

// ── 发一个必然触发子代理派活的需求 ──────────────────────
const TASK = `请用 task 工具同时派出 3 个 general 子代理，各自独立调研以下 3 个方向：
1. 2026 年主流开源多智能体框架的对比
2. 检索类任务为什么要用子代理而不是单个 agent
3. 子代理并发时 token 成本的实测数据
等 3 个都完成后，给我一份汇总对比。`
log('\n发送需求…')
const sendRes = await (await fetch(`${UI}/api/send`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: TASK }),
})).json()
log(`  sessionID = ${sendRes.sessionID}`)
check('发送成功', !!sendRes.sessionID, sendRes.error || '')

const rootId = sendRes.sessionID
log('\n等待主 AI 拆解并派活（最多 5 分钟）…')
let seenChild = null
for (let i = 0; i < 150; i++) {
  await sleep(2000)
  const c = log_.find(e => e.type === 'session.created' && e.properties?.info?.parentID === rootId)
  if (c) { seenChild = c.properties.info; break }
}

log('')
log('─'.repeat(60))
const created = log_.filter(e => e.type === 'session.created').map(e => e.properties.info)
log(`共创建 ${created.length} 个会话：`)
for (const s of created) {
  log(`  ${s.id}  parentID=${s.parentID ? s.id === rootId ? '(根)' : '有' : '无'}  agent=${s.agent || '-'}  title=${String(s.title || '').slice(0, 30)}`)
}

check('主窗口已创建', created.some(s => s.id === rootId))
check('★ 自动分裂：出现带 parentID 的子会话',
  created.filter(s => s.parentID === rootId).length > 0,
  `${created.filter(s => s.parentID === rootId).length} 个子会话`)

const children = created.filter(s => s.parentID === rootId)
if (children.length > 1) check('★ 分裂出 3 个或以上', children.length >= 3, `${children.length} 个`)

// 思考过程
const reasoning = log_.filter(e => e.type === 'message.part.updated' && e.properties?.part?.type === 'reasoning')
const deltas = log_.filter(e => e.type === 'message.part.delta')
const rsnWithText = reasoning.filter(e => (e.properties.part.text || '').length > 0)
log('')
log(`reasoning part 事件 ${reasoning.length} 个（其中 ${rsnWithText.length} 个带内容）`)
log(`delta 事件 ${deltas.length} 个`)
check('★ 思考过程有内容', rsnWithText.length > 0, rsnWithText[0] ? `"${rsnWithText[0].properties.part.text.slice(0, 60)}…"` : '')

// 思考耗时字段
const withTime = reasoning.filter(e => e.properties?.part?.time?.start)
check('★ 思考过程带耗时（可显示"思考了 12.3s"）', withTime.length > 0,
  withTime[0] ? `start=${withTime[0].properties.part.time.start}` : '')

// 状态灯
const statuses = log_.filter(e => e.type === 'session.status')
const stypes = [...new Set(statuses.map(e => e.properties?.status?.type))]
check('★ 状态灯有 idle/busy 状态', stypes.includes('busy') || stypes.includes('idle'), stypes.join(','))

// subtask 派活记录
const subtasks = log_.filter(e => e.type === 'message.part.updated' && e.properties?.part?.type === 'subtask')
check('有 subtask 派活记录', subtasks.length > 0, `${subtasks.length} 条`)

// 工具调用
const tools = log_.filter(e => e.type === 'message.part.updated' && e.properties?.part?.type === 'tool')
check('有工具调用记录', tools.length > 0, `${tools.length} 个`)

// 等待完成
log('')
log('等待全部完成…')
for (let i = 0; i < 180; i++) {
  await sleep(2000)
  const st = await (await fetch(`${UI}/api/state`)).json()
  const mine = st.sessions.filter(s => s.id === rootId || children.some(c => c.id === s.id))
  if (mine.length && mine.every(s => s.status === 'idle')) break
}
const finalState = await (await fetch(`${UI}/api/state`)).json()
log('')
log('─'.repeat(60))
for (const s of finalState.sessions) {
  log(`  ${s.id === rootId ? '根' : '子'} ${String(s.title || '').slice(0, 26).padEnd(28)} ${s.status.padEnd(7)} 思考${String(s.reasoningChars).padStart(5)}字 正文${String(s.textChars).padStart(5)}字 完成${s.completed}`)
}
const totalRsn = finalState.sessions.reduce((n, s) => n + s.reasoningChars, 0)
const totalTxt = finalState.sessions.reduce((n, s) => n + s.textChars, 0)
check('汇总后有思考内容', totalRsn > 0, `${totalRsn} 字`)
check('汇总后有正文内容', totalTxt > 0, `${totalTxt} 字`)

writeFileSync('/tmp/opencode/m4-events.json', JSON.stringify(log_))
log('')
log(`事件已存 /tmp/opencode/m4-events.json`)
log('═'.repeat(60))
log(fails === 0 ? 'M4 全部通过 ✅' : `M4 ${fails} 项失败 ❌`)
log('═'.repeat(60))
try { await reader.cancel() } catch {}
process.exit(fails === 0 ? 0 : 1)
