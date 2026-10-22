// 跨会话全文搜索 —— FTS5 + 自建 CJK bigram 分词
//
// 为什么必须自己分词（实测结论，别改成 unicode61/trigram）：
//   - unicode61（SQLite 默认分词器）：中文查询**全废**。实测「优先级」「导航」「宽度」命中数全是 0，
//     因为它把一整串汉字当成一个 token，短词永远匹配不上。
//   - trigram：能查中文，但**查询必须 ≥3 字符**。实测「优先级」命中、「导航」「宽度」命中 0，
//     而两字词（导航/宽度/折叠）在中文里太常见了，等于不能用。
//   - 所以：入库时把汉字切成**重叠 bigram**（「优先级导航」→ 优先 先级 级导 导航），
//     查询时切同样的 bigram，用 FTS5 phrase 查询串起来。英文/数字按词切，照常命中。
//
// 索引库是**独立文件**，opencode.db 全程只读（项目铁律：绝不写用户的库）。
// 实测数据量：322 会话 / 2246 条正文 / 1.25MB 文本，全量重建 <1 秒，索引约几 MB。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig } from './paths.mjs'
import { db as srcDb } from './db.mjs'

const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/

/**
 * 把一段文本切成用于 FTS 的 token 串。
 * 汉字 → 重叠 bigram；拉丁字母/数字 → 整词（小写）。
 * 单字（只有一个汉字）保留原字。
 */
export function segment(text) {
  const out = []
  const runs = String(text ?? '').match(
    /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]+|[a-zA-Z0-9_]+|./g,
  ) || []
  for (const r of runs) {
    if (CJK.test(r[0])) {
      if (r.length === 1) out.push(r)
      else for (let i = 0; i < r.length - 1; i++) out.push(r.slice(i, i + 2))
    } else if (/[a-zA-Z0-9_]/.test(r[0])) {
      out.push(r.toLowerCase())
    }
    // 其余字符（标点/空格）丢弃，不进索引
  }
  return out
}

/** 查询串 → FTS5 phrase 查询。返回 null 表示这个查询没法走 FTS（交给 LIKE 兜底） */
export function buildMatchQuery(q) {
  const toks = segment(q)
  if (!toks.length) return null
  // 单个汉字切不出 bigram，退回原字；短语查询保证 bigram 连续出现
  return '"' + toks.join(' ') + '"'
}

/** 是否需要 LIKE 兜底：单个汉字 / 没有任何可索引 token */
function needsLike(q) {
  const toks = segment(q)
  return !toks.length || toks.length === 1
}

function indexPath() {
  const cfg = loadConfig()
  const p = cfg.paths.searchIndex || join(homedir(), '.ai-console', 'search.db')
  return p
}

let idx = null
let idxMtime = 0

function openIndex() {
  const p = indexPath()
  mkdirSync(dirname(p), { recursive: true })
  const h = new DatabaseSync(p)
  h.exec(`
    create virtual table if not exists doc using fts5(
      tokens,
      raw UNINDEXED,
      session_id UNINDEXED,
      message_id UNINDEXED,
      part_id UNINDEXED,
      role UNINDEXED,
      agent UNINDEXED,
      sid_title UNINDEXED,
      time_created UNINDEXED
    );
    create table if not exists meta (k text primary key, v text);
  `)
  idx = h
  return h
}

function metaGet(k) {
  try {
    return idx.prepare('select v from meta where k = ?').get(k)?.v ?? null
  } catch { return null }
}
function metaSet(k, v) {
  idx.prepare('insert into meta(k,v) values(?,?) on conflict(k) do update set v=excluded.v').run(k, String(v))
}

const SOURCE_SQL = `
  select
    p.id            as part_id,
    p.message_id    as message_id,
    p.session_id    as session_id,
    p.time_created  as time_created,
    json_extract(p.data,'$.text')                as text,
    json_extract(m.data,'$.role')                as role,
    json_extract(m.data,'$.agent')               as agent,
    s.title          as title
  from part p
  join message m on m.id = p.message_id
  join session s on s.id = p.session_id
  where json_extract(p.data,'$.type') = 'text'
    and json_extract(p.data,'$.text') is not null
    and length(json_extract(p.data,'$.text')) > 0
  order by p.time_created
`

/**
 * 保证索引是最新的。
 * 用「源库 mtime + 最大 part 时间」当指纹；变了就全量重建（1.25MB，实测 <1s，够用）。
 * 增量重建（按 time_created 续）留了口子：fingerprint 里存了 maxPartId 起点。
 */
export function ensureIndex({ force = false } = {}) {
  const src = srcDb()
  if (!idx) openIndex()
  const srcPath = loadConfig().paths.db
  let srcStat = { mtime: 0, size: 0 }
  try {
    const s = statSync(srcPath)
    srcStat = { mtime: s.mtimeMs, size: s.size }
  } catch {}

  const maxRow = src.prepare(`
    select coalesce(max(p.time_created),0) t
    from part p where json_extract(p.data,'$.type')='text'
  `).get()?.t ?? 0

  const fp = `${Math.floor(srcStat.mtime)}:${srcStat.size}:${maxRow}`
  if (!force && metaGet('fingerprint') === fp) return { rebuilt: false, docs: null }

  const total = src.prepare(`
    select count(*) c from part p
    where json_extract(p.data,'$.type')='text' and length(json_extract(p.data,'$.text'))>0
  `).get()?.c ?? 0

  idx.exec('delete from doc')
  const rows = src.prepare(SOURCE_SQL).all()
  const ins = idx.prepare(`
    insert into doc(tokens, raw, session_id, message_id, part_id, role, agent, sid_title, time_created)
    values (?,?,?,?,?,?,?,?,?)
  `)
  idx.exec('begin')
  try {
    for (const r of rows) {
      const toks = segment(r.text)
      if (!toks.length) continue
      ins.run(toks.join(' '), r.text, r.session_id, r.message_id, r.part_id,
        r.role || '', r.agent || '', r.title || '', r.time_created ?? 0)
    }
    idx.exec('commit')
  } catch (e) {
    try { idx.exec('rollback') } catch {}
    throw e
  }
  metaSet('fingerprint', fp)
  metaSet('indexed_at', Date.now())
  metaSet('doc_count', rows.length)
  return { rebuilt: true, docs: rows.length }
}

export function indexStatus() {
  const total = srcDb().prepare(`
    select count(*) c from part p
    where json_extract(p.data,'$.type')='text' and length(json_extract(p.data,'$.text'))>0
  `).get()?.c ?? 0
  return {
    indexedDocs: Number(metaGet('doc_count') || 0),
    sourceDocs: total,
    indexedAt: Number(metaGet('indexed_at') || 0),
    indexPath: indexPath(),
  }
}

/** 在 raw 里定位查询词，返回 [start, end]；找不到返回 null */
function locate(hay, needle) {
  const i = hay.toLowerCase().indexOf(needle.toLowerCase())
  return i < 0 ? null : [i, i + needle.length]
}

/**
 * 搜索。
 * 返回 [{session_id, message_id, part_id, role, agent, title, time_created, snippet, terms}]
 * snippet 里命中片段用 \u0001 ... \u0002 包起来，前端渲染成高亮（避开 innerHTML 注入）。
 */
export function search(q, { limit = 40, sessionId = null } = {}) {
  const query = String(q || '').trim()
  if (!query) return []
  ensureIndex()

  let rows = []
  const mq = buildMatchQuery(query)
  if (mq) {
    try {
      rows = idx.prepare(`
        select session_id, message_id, part_id, role, agent, sid_title, time_created, raw
        from doc where doc match ?
        order by time_created desc limit ?
      `).all(mq, limit * 2)
    } catch { rows = [] }
  }
  // 单个汉字 / 无 token → LIKE 兜底
  if (!rows.length && needsLike(query)) {
    rows = idx.prepare(`
      select session_id, message_id, part_id, role, agent, sid_title, time_created, raw
      from doc where raw like ?
      order by time_created desc limit ?
    `).all(`%${query}%`, limit * 2)
  }

  const seen = new Set()
  const out = []
  const termList = segment(query).filter((t) => t.length > 1 || !CJK.test(t))
  for (const r of rows) {
    if (sessionId && r.session_id !== sessionId) continue
    const key = r.part_id
    if (seen.has(key)) continue
    seen.add(key)

    // 片段：优先定位查询词；定位不到（分词命中但原文连续形式不同）就取开头
    const pos = locate(r.raw, query)
    const RADIUS = 70
    let snippet
    if (pos) {
      const s = Math.max(0, pos[0] - RADIUS)
      const e = Math.min(r.raw.length, pos[1] + RADIUS)
      snippet = (s > 0 ? '…' : '')
        + r.raw.slice(s, pos[0]) + '\u0001' + r.raw.slice(pos[0], pos[1]) + '\u0002' + r.raw.slice(pos[1], e)
        + (e < r.raw.length ? '…' : '')
    } else {
      const head = r.raw.slice(0, RADIUS * 2)
      snippet = head + (r.raw.length > RADIUS * 2 ? '…' : '')
    }
    out.push({
      session_id: r.session_id,
      message_id: r.message_id,
      part_id: r.part_id,
      role: r.role,
      agent: r.agent,
      title: r.sid_title,
      time_created: r.time_created,
      snippet,
    })
    if (out.length >= limit) break
  }
  return out
}

export function closeSearch() {
  try { idx?.close() } catch {}
  idx = null
}
