// 只读访问 opencode.db（历史记录的数据源）
//
// 真实表结构（踩过坑，别改）：
//   session : id, project_id, workspace_id, parent_id, directory, title, cost,
//             tokens_input/output/reasoning/cache_read/cache_write, agent, model,
//             time_created, time_updated, time_archived …  ← token 是独立列
//   message : id, session_id, time_created, data(TEXT)      ← role/agent/tokens 在 data JSON 里
//   part    : id, message_id, session_id, time_created, data(TEXT) ← type/text/state 在 data JSON 里
//   project : id, worktree, vcs, name, time_created
//
// 所以过滤 part 类型必须用 json_extract(data,'$.type')，表里没有 type 列。
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './paths.mjs'

let handle = null
let openedPath = null
let openedAt = 0

function openDb() {
  const p = loadConfig().paths.db
  if (!existsSync(p)) throw new Error(`找不到数据库: ${p}`)
  try {
    // 实测：SQLite 在 WAL 模式下允许多个只读连接，能看到别���程提交的数据。
    handle = new DatabaseSync(p, { readOnly: true })
    openedPath = p
    openedAt = Date.now()
    return handle
  } catch (err) {
    // 兜底：万一被锁，退到"拷一份再只读"的路子（实测复制 71MB 只要 0.05s）
    const work = mkdtempSync(join(tmpdir(), 'aiconsole-db-'))
    copyFileSync(p, join(work, 'opencode.db'))
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(p + ext)) copyFileSync(p + ext, join(work, `opencode.db${ext}`))
    }
    handle = new DatabaseSync(join(work, 'opencode.db'), { readOnly: true })
    openedPath = work
    openedAt = Date.now()
    return handle
  }
}

export function db() {
  if (!handle) openDb()
  return handle
}

export function closeDb() {
  try { handle?.close() } catch {}
  handle = null
  if (openedPath && openedPath.startsWith(tmpdir())) {
    try { rmSync(openedPath, { recursive: true, force: true }) } catch {}
  }
  openedPath = null
}

const all = (sql, ...args) => db().prepare(sql).all(...args)
const one = (sql, ...args) => db().prepare(sql).get(...args)

// ── 会话列表 ────────────────────────────────────────────────
export function listSessions({ limit = 50, search = '', includeArchived = false } = {}) {
  const where = []
  const args = []
  if (!includeArchived) where.push('s.time_archived is null')
  if (search) {
    where.push('(s.title like ? or s.directory like ? or s.id like ?)')
    const q = `%${search}%`
    args.push(q, q, q)
  }
  return all(`
    select s.id, s.title, s.directory, s.agent, s.model, s.project_id, s.parent_id,
           s.cost, s.tokens_input ti, s.tokens_output to_, s.tokens_reasoning tr,
           s.tokens_cache_read tcr, s.tokens_cache_write tcw,
           s.time_created, s.time_updated, s.time_archived,
           (select count(*) from message m where m.session_id = s.id) as message_count,
           (select count(*) from part p where p.session_id = s.id
              and json_extract(p.data,'$.type')='reasoning') as reasoning_count,
           (select count(*) from part p where p.session_id = s.id
              and json_extract(p.data,'$.type')='tool') as tool_count
    from session s
    ${where.length ? 'where ' + where.join(' and ') : ''}
    order by s.time_updated desc
    limit ?
  `, ...args, limit)
}

export function getSession(id) {
  return one(`select * from session where id = ?`, id)
}

/** 子代理会话（parent_id 非空）—— M4 自动分裂的历史数据源 */
export function listChildSessions() {
  return all(`
    select id, parent_id, title, agent, directory, time_created, time_updated
    from session where parent_id is not null order by time_created
  `)
}

/** 会话树：父 → 子 */
export function getSessionTree() {
  const rows = all(`
    select id, parent_id, title, agent, directory, time_created, time_updated,
           tokens_reasoning tr
    from session where time_archived is null order by time_created desc
  `)
  const byId = new Map()
  for (const r of rows) byId.set(r.id, { ...r, children: [] })
  const roots = []
  for (const n of byId.values()) {
    const parent = n.parent_id ? byId.get(n.parent_id) : null
    if (parent) parent.children.push(n)
    else roots.push(n)
  }
  return { roots, count: byId.size, childCount: rows.length - roots.length }
}

// ── 消息与part ───────────────────────────────────────────────
export function getMessages(sessionId, { includeSystem = false } = {}) {
  const rows = all(`
    select m.id, m.time_created, m.data
    from message m where m.session_id = ?
    order by m.time_created
  `, sessionId)
  const out = []
  for (const r of rows) {
    let d = {}
    try { d = JSON.parse(r.data) } catch {}
    if (!includeSystem && d.role === 'system') continue
    out.push({
      id: r.id,
      role: d.role,
      agent: d.agent,
      model: d.modelID,
      provider: d.providerID,
      cost: d.cost ?? 0,
      tokens: d.tokens ?? null,
      time: d.time ?? null,
      parts: getParts(r.id),
    })
  }
  return out
}

export function getParts(messageId) {
  const rows = all(`select id, data from part where message_id = ? order by time_created`, messageId)
  const out = []
  for (const r of rows) {
    let d = {}
    try { d = JSON.parse(r.data) } catch {}
    out.push({
      id: r.id,
      type: d.type,
      text: d.text,
      time: d.time,
      tool: d.tool,
      state: d.state ? {
        status: d.state.status,
        input: d.state.input,
        output: typeof d.state.output === 'string' ? d.state.output.slice(0, 400) : d.state.output,
        title: d.state.title,
      } : undefined,
      agent: d.agent,
      description: d.description,
      prompt: d.prompt,
    })
  }
  return out
}

// ──统计 ─────────────────────────────────────────────────────
export function getStats() {
  const t = one(`
    select count(*) sessions,
           coalesce(sum(cost),0) cost,
           coalesce(sum(tokens_input),0) ti,
           coalesce(sum(tokens_output),0) to_,
           coalesce(sum(tokens_reasoning),0) tr,
           coalesce(sum(tokens_cache_read),0) tcr
    from session where time_archived is null
  `)
  const parts = all(`select json_extract(data,'$.type') t, count(*) n from part group by t order by n desc`)
  const byDir = all(`
    select directory, count(*) n from session
    where time_archived is null group by directory order by n desc limit 8
  `)
  return { ...t, parts, byDir, dbMtime: (() => { try { return statSync(loadConfig().paths.db).mtimeMs } catch { return 0 } })() }
}

export function listProjects() {
  return all(`select id, worktree, vcs, name, time_created from project order by time_created desc`)
}