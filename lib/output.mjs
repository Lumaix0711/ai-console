// 汇总落盘：主会话跑完一轮后，把它的最终答案写进 output/
// 设计要点：
// - 一个会话对应一个文件，再次 idle 时覆盖（而不是每次都新增，避免刷屏）
// - 内容来自只读数据库（比内存态可靠，页面没开也能写）
// - 顺便写一份 output/index.md 目录，方便点开就知道有哪些
import { existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSession, getMessages, listSessions } from './db.mjs'

const INDEX = 'index.md'

/** 取一个会话里最后一条 assistant 消息的正文（拼接所有 text part） */
function lastAssistantText(sessionID) {
  const msgs = getMessages(sessionID, { includeSystem: false })
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue
    const t = msgs[i].parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n').trim()
    if (t) return t
  }
  return ''
}

const pad = (n) => String(n).padStart(2, '0')
const stamp = (ms) => {
  const d = new Date(ms)
  return {
    iso: d.toISOString(),
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hm: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    human: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/** session.model 在库里是 {id, providerID, variant} 对象，直接插值会变成 [object Object] */
function modelId(m) {
  if (!m) return ''
  if (typeof m === 'object') return m.id || m.modelID || ''
  // 库里 session.model 是 TEXT 列，里面存的是 JSON 字符串，例如
  // '{"id":"space-bunny-free","providerID":"opencode"}'
  const t = String(m).trim()
  if (t.startsWith('{')) {
    try { const o = JSON.parse(t); return o.id || o.modelID || '' } catch { return '' }
  }
  return t
}

/** 文件名安全化：去掉路径分隔符和 Windows 非法字符，保留中文 */
function slug(title, max = 40) {
  const s = String(title || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')   // 去掉首尾的点和空格，避免出现 "xxx。.md"
    .slice(0, max)
    .replace(/[.\s]+$/g, '')
  return s || '未命名'
}

/** 已落盘会话 → 文件名。用于同一个会话再次完成时覆盖而不是新建 */
const written = new Map()

function findExisting(dir, sessionID) {
  for (const f of readdirSync(dir)) {
    if (f === INDEX || !f.endsWith('.md')) continue
    try {
      const head = readFileSync(join(dir, f), 'utf8').slice(0, 400)
      if (head.includes(`\`${sessionID}\``)) return f
    } catch {}
  }
  return null
}

export function writeSummary({ outputDir, sessionID, onSaved }) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })

  const sess = getSession(sessionID)
  if (!sess) return null

  // 只处理主会话（有 parent_id 的是子代理，不单独落盘）
  if (sess.parent_id) return null

  const summary = lastAssistantText(sessionID)
  if (!summary) return null            // 空产出不写文件

  const t = stamp(sess.time_updated || Date.now())

  // 子代理清单：让文件能看出"这份汇总背后派了谁"
  const kids = listSessions({ limit: 300 }).filter((r) => r.parent_id === sessionID)

  const file = written.get(sessionID) || findExisting(outputDir, sessionID)
    || `${t.day}-${t.hm}-${slug(sess.title)}.md`
  written.set(sessionID, file)

  const meta = [
    `- 会话：\`${sessionID}\``,
    `- 模式 / agent：\`${sess.agent || '?'}\``,
    `- 模型：\`${modelId(sess.model) || '（未记录，运行时由前端指定）'}\``,
    `- 完成时间：${t.human}`,
    `- 子代理：${kids.length ? kids.map((k) => `\`${k.agent}\`（${k.title || '无标题'}）`).join('、') : '无'}`,
    '',
  ].join('\n')

  const body = `# ${sess.title || '未命名'}\n\n${meta}\n---\n\n${summary}\n`

  const full = join(outputDir, file)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(full, body, 'utf8')

  const bytes = statSync(full).size
  writeIndex(outputDir)
  onSaved?.({ file, bytes, sessionID })
  return { file, bytes }
}

// 导出的原因：删掉某些汇总文件后，光删文件索引不会自己变（它只在 writeSummary 里被调用）。
// 单独跑一次 `node -e "import('./lib/output.mjs').then(m=>m.writeIndex('output'))"` 就能重建目录页。
export function writeIndex(outputDir) {
  const files = readdirSync(outputDir)
    .filter((f) => f.endsWith('.md') && f !== INDEX)
    .map((f) => ({ f, m: statSync(join(outputDir, f)).mtimeMs, b: statSync(join(outputDir, f)).size }))
    .sort((a, b) => b.m - a.m)

  let md = '# 汇总结果\n\n由 AI Console 自动生成，每次主会话跑完一轮覆盖同名文件。\n\n'
  if (!files.length) md += '_（还没有内容）_\n'
  for (const x of files) {
    let title = x.f.replace(/\.md$/, '')
    try {
      const first = readFileSync(join(outputDir, x.f), 'utf8').split('\n').find((l) => l.startsWith('# '))
      if (first) title = first.slice(2).trim()
    } catch {}
    const d = new Date(x.m)
    md += `- [${title}](<${x.f}>) · ${stamp(x.m).human} · ${(x.b / 1024).toFixed(1)}KB\n`
  }
  writeFileSync(join(outputDir, INDEX), md, 'utf8')
}