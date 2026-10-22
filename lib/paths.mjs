// 路径解析 —— 整个项目"路径无关"的根基。
// 代码永远指向自己所在的文件夹，所以整个文件夹搬到任何地方都不用改代码。
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'

// lib/paths.mjs → lib → 项目根
export const LIB_DIR = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(LIB_DIR)
export const PUBLIC_DIR = join(ROOT, 'public')

/**
 * 把配置里的路径字符串变成绝对路径。
 *   "~/x"    → /home/<你>/x        （随用户走）
 *   "output" → <项目根>/output        （随文件夹走）
 *   "/x"     → /x                    （原样，但配置里不该出现）
 */
export function expandPath(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  if (isAbsolute(p)) return p
  return join(ROOT, p)
}

let cached = null
export function loadConfig() {
  if (cached) return cached
  const raw = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  cached = {
    ...raw,
    paths: Object.fromEntries(
      Object.entries(raw.paths).map(([k, v]) => [k, expandPath(v)])
    ),
  }
  cached.upstream.baseUrl = `http://${raw.upstream.host}:${raw.upstream.port}`
  return cached
}

/** 列出 config.json 里残留的绝对路径——迁移体检用 */
export function auditPaths() {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  const bad = []
  // 只认真正写死的绝对路径：/开头 或盘符开头。
  // "~/" 开头的恰恰是可移植写法，不算问题；"output" 这种相对路径也没问题。
  const looksHardCoded = (s) => /^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s)
  const walk = (o, path = '') => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('_')) continue
      const p = path ? `${path}.${k}` : k
      if (typeof v === 'string' && looksHardCoded(v)) bad.push(`${p} = ${v}`)
      else if (v && typeof v === 'object') walk(v, p)
    }
  }
  walk(raw)
  return bad
}

export function selfCheck() {
  return {
    root: ROOT,
    publicDir: PUBLIC_DIR,
    publicExists: existsSync(PUBLIC_DIR),
    outputDir: loadConfig().paths.outputDir,
    outputExists: existsSync(loadConfig().paths.outputDir),
    absolutePathsInConfig: auditPaths(),
  }
}