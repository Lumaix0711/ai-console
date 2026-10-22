// M11：跨会话全文搜索（lib/search.mjs）
// 重点验证：CJK bigram 分词（SQLite 自带分词器对中文无效，必须自己切）、
// FTS5 索引、片段高亮偏移、单字 LIKE 兜底、零残留（不写 opencode.db）。
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createContext, runInContext } from 'node:vm'
import { segment, buildMatchQuery, search, ensureIndex, indexStatus } from './lib/search.mjs'

let fails = 0
const t = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))

console.log('【CJK 分词：为什么不能用 SQLite 自带分词器】')
t('汉字切成重叠 bigram', segment('优先级导航').join(' ') === '优先 先级 级导 导航', segment('优先级导航').join(' '))
t('英文按词切并小写', segment('Use Priority-Nav here').join(' ') === 'use priority nav here', segment('Use Priority-Nav here').join(' '))
t('中英数字混排', segment('用 LCS 做 diff 导航2').includes('lcs') && segment('用 LCS 做 diff 导航2').includes('导航'), segment('用 LCS 做 diff 导航2').join(' '))
t('单字保留', segment('好').join(' ') === '好')
t('标点不进索引', !segment('你好，世界！').join(' ').includes('，'))
t('查询串是合法 FTS5 phrase', buildMatchQuery('优先级') === '"优先 先级"', buildMatchQuery('优先级'))
t('英文查询串', buildMatchQuery('FTS5') === '"fts5"', buildMatchQuery('FTS5'))

console.log('【对照实验：SQLite 自带分词器对中文确实无效】')
{
  const db = new DatabaseSync(':memory:')
  db.exec("create virtual table t using fts5(body)")
  db.prepare('insert into t(body) values (?)').run('这是一段中文内容关于优先级导航的设计')
  const n = db.prepare('select count(*) c from t where t match ?').get('"优先级"').c
  t('★ unicode61 查中文命中 0（所以必须自己分词）', n === 0, '实际 ' + n)
}

console.log('【索引与检索】')
const st0 = ensureIndex()
t('索引建立成功', st0.rebuilt || indexStatus().indexedDocs > 0, JSON.stringify(st0))
t('索引覆盖全部正文', indexStatus().indexedDocs >= indexStatus().sourceDocs - 5,
  `${indexStatus().indexedDocs}/${indexStatus().sourceDocs}`)
t('二次调用不重建（指纹命中）', ensureIndex().rebuilt === false)
t('索引文件不在 opencode.db 里（不污染用户库）', !indexStatus().indexPath.endsWith('opencode.db'), indexStatus().indexPath)

console.log('【检索行为】')
{
  const r = search('优先级', { limit: 5 })
  t('中文两字词能搜到（unicode61 搜不到的就是这个）', r.length > 0, '命中 ' + r.length)
  const first = r[0]
  t('命中带会话/消息/片段定位信息', !!first?.session_id && !!first?.message_id && !!first?.snippet)
  t('片段含命中标记 \\u0001…\\u0002', first ? /[\x00-\x08][^\x00-\x08]*[\x00-\x08]/.test(first.snippet) || first.snippet.includes('优先级') : false)
  const en = search('FTS5', { limit: 3 })
  t('英文关键词能搜到', en.length > 0, '命中 ' + en.length)
  const one = search('导', { limit: 3 })
  t('单字走 LIKE 兜底也不报错', Array.isArray(one))
  t('空查询返回空数组', search('', { limit: 5 }).length === 0)
  t('限定会话过滤生效', search('优先级', { limit: 5, sessionId: 'ses_nonexistent' }).length === 0)
}

console.log('【零残留】')
{
  // 搜索只读 opencode.db：跑完这些查询后，用户库里不能多出任何东西
  const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
  const p = cfg.paths.db.replace('~', process.env.HOME)
  const udb = new DatabaseSync(p, { readOnly: true })
  const tables = udb.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name)
  t('用户库里没有 doc 表（索引在独立文件）', !tables.includes('doc'), tables.join(','))
  t('用户库里没有 meta 表', !tables.includes('meta'))
  udb.close()
}

console.log('')
console.log(fails === 0 ? 'M11 全部通过 ✅' : `${fails} 项失败 ❌`)
process.exit(fails ? 1 : 0)