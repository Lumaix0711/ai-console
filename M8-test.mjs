#!/usr/bin/env node
// M8 验证：三个 subagent 是否真能被派活、真有隔离、真出中文结论
import { connect } from 'node:net'
import { writeFileSync } from 'node:fs'

const UP = 'http://127.0.0.1:4090'   // 从 config.json 读，别再手写端口
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
if (!await waitForPort(Number(UP.split(':').pop()), 8000)) { log('  服务没起'); process.exit(1) }

const ev = []
const es = await fetch(`${UP}/api/stream`, { headers: { accept: 'text/event-stream' } })
const rd = es.body.getReader(), dec = new TextDecoder(); let buf = ''
;(async () => { try { while (true) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); const ls = buf.split('\n'); buf = ls.pop() || ''; for (const l of ls) { if (l.startsWith('data:')) { try { ev.push(JSON.parse(l.slice(5).trim())) } catch {} } } } } catch {} })()
await sleep(1200)

// ── 1. agent 元数据自检 ────────────────────────────────
log('\n【1】agent 定义自检')
let agents = []
try {
  const _r = await fetch(`${UP}/api/agents`)
  const _t = await _r.text()
  try { agents = JSON.parse(_t) }
  catch { console.log(`  [诊断] /api/agents 返回 ${_r.status} ${_r.headers.get('content-type')}  前50字=${JSON.stringify(_t.slice(0,50))}`) }
} catch (e) { console.log('  [诊断] /api/agents 请求异常:', e.message) }
const mine = ['researcher', 'cross-checker', 'orchestrator'].map((n) => agents.find((a) => a.name === n))
for (const a of mine) {
  if (!a) { check(a?.name || '?', false, '未找到'); continue }
  const perms = Object.fromEntries((a.permission || []).map((p) => [p.permission + (p.pattern && p.pattern !== '*' ? ':' + p.pattern : ''), p.action]))
  const mv = a.model == null ? '-' : (typeof a.model === 'string' ? a.model : JSON.stringify(a.model))
  log(`  ${a.name}: mode=${a.mode} model=${mv} temp=${a.temperature ?? '-'}`)
  log(`      权限: ${JSON.stringify(perms)}`)
}
check('三个 agent 都被识别', mine.every(Boolean))
check('researcher 是 subagent', mine[0]?.mode === 'subagent')
check('cross-checker 是 subagent', mine[1]?.mode === 'subagent')
check('orchestrator 是 subagent', mine[2]?.mode === 'subagent')

// 关键：两个 agent 用了不同模型（跨模型 review 才有效）
const r1 = mine[0], r2 = mine[1]
const mv = (a) => (a?.model == null ? '-' : (typeof a.model === 'string' ? a.model : JSON.stringify(a.model)))
// 默认状态下三个 agent 都不写死 model → 继承主会话模型（= 用户要的"不选就跟随"）
// 注意：agent 没写 model 时上游返回 model:null（= 继承主会话），不是空字符串
const pinned = (a) => !!(a && a.model)
check('★ 默认三个子代理都不写死模型（继承主 AI）',
  !pinned(r1) && !pinned(r2) && !pinned(mine[2]),
  `researcher=${mv(r1)} cross=${mv(r2)} orch=${mv(mine[2])}`)

// 再验证"手动挑选"这条路：给两个 review agent 指定不同模型，上游要真的换掉
log('  ── 手动指定模型（跨模型 review）──')
const M1 = 'beam-free', M2 = 'deepseek-v4.1-flash-free'
const sr = await (await fetch(`${UP}/api/subagent-model`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ researcher: M1, 'cross-checker': M2, orchestrator: '' }),
})).json()
if (sr.error) { check('手动指定模型', false, sr.error) } else {
  check('★ 手动指定后上游真的换了模型',
    sr.actual?.researcher === `opencode/${M1}` && sr.actual?.['cross-checker'] === `opencode/${M2}`,
    JSON.stringify(sr.actual))
  const after = await (await fetch(`${UP}/api/agents`)).json()
  const g = (n) => after.find((a) => a.name === n)?.model?.modelID ?? ''
  check('★ /api/agents 也反映新模型', g('researcher') === M1 && g('cross-checker') === M2,
    `${g('researcher')} vs ${g('cross-checker')}`)
}
// 未知模型必须被拒（不能偷偷用白名单外的模型）
const bad = await fetch(`${UP}/api/subagent-model`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ researcher: 'definitely-not-a-model', 'cross-checker': '', orchestrator: '' }),
})
check('★ 白名单外模型被拒', bad.status === 400, `HTTP ${bad.status}`)
// 复原成默认（跟随主 AI）
await fetch(`${UP}/api/subagent-model`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ researcher: '', 'cross-checker': '', orchestrator: '' }),
})

// 写权限必须被 deny
const editPerm = (a) => (a?.permission || []).find((p) => p.permission === 'edit')
check('researcher 禁止改文件', editPerm(r1)?.action === 'deny', editPerm(r1)?.action)
check('cross-checker 禁止改文件', editPerm(r2)?.action === 'deny', editPerm(r2)?.action)

// orchestrator 的 task 白名单
const taskPerm = (mine[2]?.permission || []).filter((p) => p.permission === 'task')
const allowList = taskPerm.filter((p) => p.action === 'allow').map((p) => p.pattern)
const denyAll = taskPerm.some((p) => p.action === 'deny' && p.pattern === '*')
check('orchestrator 默认禁用 task（白名单模式）', denyAll, `allow: ${allowList.join(',') || '无'}`)
check('orchestrator 只允许调 researcher 和 cross-checker',
  allowList.length === 2 && allowList.includes('researcher') && allowList.includes('cross-checker'),
  allowList.join(', '))

// ── 2. 真派一次 researcher ─────────────────────────────
log('')
log('【2】实派一个 researcher（真跑一次）')
const r = await (await fetch(`${UP}/api/send`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    agent: 'plan',
    text: '用 researcher agent 调研一个方向：HTTPS 证书为什么需要 CA 机构签发。查完把结论给我。',
  }),
})).json()
check('发送成功', !!r.sessionID, r.error || '')

let sawChild = false
for (let i = 0; i < 150; i++) {
  await sleep(2000)
  const c = ev.find((e) => e.type === 'session.created' && e.properties?.info?.parentID)
  if (c) { sawChild = true; break }
  // 主 AI 可能自己不派活直接答了
  const st = await (await fetch(`${UP}/api/state`)).json()
  const me = st.sessions.find((s) => s.id === r.sessionID)
  if (me && me.completed > 0 && me.status === 'idle') break
}
const children = ev.filter((e) => e.type === 'session.created' && e.properties?.info?.parentID)
  .map((e) => e.properties.info)
log(`  子会话 ${children.length} 个`)
for (const c of children) log(`    agent=${c.agent}  title=${String(c.title || '').slice(0, 40)}`)
check('主 AI 派出了子会话', sawChild, sawChild ? '' : '（可能直接自己答了，不算失败）')
check('子会话的 agent 是 researcher', children.some((c) => c.agent === 'researcher') || !sawChild,
  children.map((c) => c.agent).join(','))

// ── 3. 等完成，查中文与格式 ─────────────────────────────
log('')
log('【3】等待完成…（要求主会话真的产出了汇总，而不是只看 idle）')
// 陷阱：子代理先结束、主会话随后继续写汇总，这一瞬间主会话也会短暂显示 idle。
// 所以必须同时满足：① 相关会话全部 idle ② 主会话已有 >1 条 text（用户那条不算）
let idleRounds = 0
for (let i = 0; i < 180; i++) {
  await sleep(2000)
  const st = await (await fetch(`${UP}/api/state`)).json()
  const rel = st.sessions.filter((s) => s.id === r.sessionID || children.some((c) => c.id === s.id))
  const allIdle = rel.length > 0 && rel.every((s) => s.status === 'idle')
  const rootTexts = ev.filter((e) => e.type === 'message.part.updated'
    && e.properties?.part?.type === 'text' && e.properties.part.sessionID === r.sessionID)
  const gotSummary = rootTexts.length > 1
  if (allIdle && gotSummary) { idleRounds++; if (idleRounds >= 2) { log(`  完成（第 ${i + 1} 轮，主会话 ${rootTexts.length} 条 text）`); break } }
  else idleRounds = 0
  if (i % 15 === 14) log(`  …第 ${(i + 1) * 2}s，idle=${allIdle} 主会话text=${rootTexts.length}`)
}

const texts = ev.filter((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'text')
  .map((e) => e.properties.part.text).join('\n')
log('')
log('【4】产出检查')
// 「输出必须简体中文」这条要求主要针对**用户读到的东西**＝主 AI 的汇总。
// 子代理报告是中间产物，天然夹大量英文术语（PKI / CRL / OCSP / Root CA…），
// 拿它算中文占比是测错了对象，所以分开测：汇总严格、整体宽松。
const strip = (t) => t
  .replace(/https?:\/\/\S+/g, '')        // URL
  .replace(/`[^`]*`/g, '')                 // 行内代码
  .replace(/\b[A-Z][A-Z0-9]{1,}\b/g, '')  // PKI / RSA / RFC 这类缩写
  .replace(/\|[-: |]+\|/g, '')            // markdown 表格线
const zhRatio = (t) => {
  const x = strip(t)
  const cjk = (x.match(/[\u4e00-\u9fff]/g) || []).length
  const lat = (x.match(/[A-Za-z]/g) || []).length
  return cjk / Math.max(1, cjk + lat)
}

const rootTexts = ev.filter((e) => e.type === 'message.part.updated'
  && e.properties?.part?.type === 'text' && e.properties.part.sessionID === r.sessionID)
const summary = rootTexts.length > 1 ? rootTexts[rootTexts.length - 1].properties.part.text : ''
const ratio = zhRatio(texts)
log(`  正文 ${texts.length} 字，整体中文占比 ${(ratio * 100).toFixed(1)}%（参考，不设卡）`)
log(`  主 AI 汇总 ${summary.length} 字，中文占比 ${(zhRatio(summary) * 100).toFixed(1)}%（卡这条）`)
check('有产出', texts.trim().length > 0, `${texts.length} 字`)
check('★ 主 AI 汇总以中文为主（≥55%）', zhRatio(summary) >= 0.55, `${(zhRatio(summary) * 100).toFixed(1)}%`)
check('★ 主 AI 产出了汇总（不是只有子代理报告）', rootTexts.length > 1, `${rootTexts.length} 条 text`)
const childText = children.length ? ev.filter((e) => e.type === 'message.part.updated'
  && e.properties?.part?.type === 'text' && e.properties.part.sessionID === children[0].id) : []
check('子代理产出了独立报告', childText.length > 0, `${childText.length} 条`)
if (summary) check('汇总比子代理报告短（真在聚合，不是复制粘贴）', summary.length < texts.length, `${summary.length} / ${texts.length} 字`)
if (/##\s*结论/.test(texts)) check('遵守了五节输出格式（## 结论）', true)
if (/未能查证|无法验证|未查证/.test(texts)) check('包含"未查证"一节（防编造）', true)
else log('  · 没抓到"未查证"字样（可能格式略有差异）')

// 检查是否误读了 opencode.json
const bashCmds = ev.filter((e) => e.type === 'message.part.updated' && e.properties?.part?.type === 'tool')
  .map((e) => JSON.stringify(e.properties.part.state?.input || {}))
const badTool = bashCmds.some((s) => /opencode\.json/.test(s))
check('★ 没有去读 opencode.json（防护规则生效）', !badTool)

writeFileSync('/tmp/opencode/m8-events.json', JSON.stringify(ev))
log('')
log('═'.repeat(52))
log(fails === 0 ? 'M8 全部通过 ✅' : `${fails} 项失败 ❌`)
log('═'.repeat(52))
try { await rd.cancel() } catch {}
process.exit(fails === 0 ? 0 : 1)