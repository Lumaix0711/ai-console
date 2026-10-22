#!/usr/bin/env node
// 在 WINDOWS 侧运行：连 Windows 本机的 CDP(9222) 截图，PNG 写到 Windows 临时目录，
// WSL 侧再读走。原因：Edge 的 CDP 只绑 Windows 的 127.0.0.1，WSL mirrored 模式够不到。
// 用法（从 WSL）：第 10 个参数是文件名标签（默认 shot）
//   由 Windows Node 通过 UNC 路径执行本文件（见 README「怎么看界面」）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP = 'http://127.0.0.1:9222'
const url = process.argv[2]
// 默认落到 <脚本所在目录>/screenshots/<YYYY-MM-DD>/HHMMSS-<标签>.png，
// 按日期分目录、文件名带时间戳，这样同一天跑多次也不会互相覆盖。
// 这个脚本现在放在 WSL 里、通过 \\wsl.localhost\... 被 Windows Node 执行。
// 注意：URL.pathname 会把 UNC 主机名吃掉（\\wsl.localhost\Ubuntu\a\b 变成 /Ubuntu/a/b），
// 那样算出来的路径是错的。必须用 fileURLToPath + path.win32 处理 UNC。
const HERE = win32.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIR = win32.resolve(HERE, '..', 'screenshots')
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const LABEL = (process.argv[10] || 'shot').replace(/[^\w.-]+/g, '-').slice(0, 40)
const autoName = `${stamp}-${LABEL}.png`
const outArg = process.argv[3]
const out = outArg && !/^\u0000$/.test(outArg)
  ? win32.resolve(outArg)
  : win32.join(DEFAULT_DIR, day, autoName)
mkdirSync(win32.dirname(out), { recursive: true })
const waitMs = Number(process.argv[4]) || 2500
const width = Number(process.argv[5]) || 1600
const height = Number(process.argv[6]) || 1000
const full = (process.argv[7] || '1') !== '0'
const evalJs = process.argv[8] || ''      // 截图前先在页面里跑这段 JS（用来点开抽屉等）
const wait2 = Number(process.argv[9]) || 1500

if (!url) { console.error('用法: node shot.mjs <url> <out.png> [waitMs] [w] [h] [fullPage 0|1]'); process.exit(2) }

const rpc = (ws) => {
  let id = 0
  const waiting = new Map()
  ws.addEventListener('message', (e) => {
    let m
    try { m = JSON.parse(e.data) } catch { return }
    if (m.id && waiting.has(m.id)) {
      const { resolve: rs, reject: rj } = waiting.get(m.id)
      waiting.delete(m.id)
      m.error ? rj(new Error(m.error.message || JSON.stringify(m.error))) : rs(m.result)
    }
  })
  return (method, params = {}) => new Promise((rs, rj) => {
    const myId = ++id
    waiting.set(myId, { resolve: rs, reject: rj })
    ws.send(JSON.stringify({ id: myId, method, params }))
    setTimeout(() => { if (waiting.has(myId)) { waiting.delete(myId); rj(new Error('CDP 超时: ' + method)) } }, 280000)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // 每次开新标签，避免污染已有页面
  const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((rs, rj) => { ws.addEventListener('open', rs); ws.addEventListener('error', () => rj(new Error('CDP WebSocket 连不上'))) })
  const send = rpc(ws)

  try {
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    })
    await send('Page.navigate', { url })
    await sleep(waitMs)

    if (evalJs) {
      const r = await send('Runtime.evaluate', { expression: evalJs, returnByValue: true, awaitPromise: true })
      await sleep(wait2)
      console.error('[eval] ' + JSON.stringify(r.result?.value ?? r.result?.description ?? 'ok'))
    }

    // 量出真实内容高度，整页截图时才不会截半
    let clip
    if (full) {
      const { result } = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight)',
      })
      const h = Math.min(Number(result?.value) || height, 12000)
      clip = { x: 0, y: 0, width, height: h, scale: 1 }
    }

    const { data } = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: !!full, ...(clip ? { clip } : {}),
    })
    writeFileSync(out, Buffer.from(data, 'base64'))

    // 顺手把控制台错误捞出来
    const errs = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: 'JSON.stringify(window.__errs||[])',
    }).catch(() => null)

    console.log(JSON.stringify({ ok: true, out, width, height, full, consoleErrs: errs?.result?.value || '[]' }))
    process.exit(0)   // rpc 每次调用都挂 280s 兜底定时器，不主动退会拖住 shell
  } finally {
    ws.close()
    await fetch(`${CDP}/json/close/${t.id}`).catch(() => {})
  }
}

main().catch((e) => { console.error('截图失败: ' + e.message); process.exit(1) })