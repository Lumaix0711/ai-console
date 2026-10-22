# AI Console

一个独立于 VSCode 终端的本地 AI 控制台：发需求 → 主 AI 自动拆解派活 → 多窗口并行 → 汇总。

> 仓库不包含 `screenshots/`、`output/` 和本地数据库；这些路径已在 `.gitignore` 中排除。
>
> 运行需要 Node.js >= 22.13（实测 26.1）和 `opencode` 可执行文件；截图相关功能仅支持 WSL + Windows。

## 隐私

本项目自身没有账号、遥测或云端存储：它只读本机 opencode 数据与配置（数据库以只读方式打开），并连接本机 `127.0.0.1` 上的 opencode 上游。会话内容仍会由 opencode 发送给你选择的模型提供商，是否记录或用于训练取决于该提供商的条款；模型选择页会标出已知的数据政策风险。

仓库不包含任何会话数据库、`output/` 汇总、`screenshots/` 截图或本地日志，相关路径均在 `.gitignore` 中。

## 与 OpenCode 的关系

本项目是第三方界面，不是 OpenCode 官方项目，与 Anomaly / OpenCode 团队没有隶属关系，也未获官方背书。

- **代码**：OpenCode 采用 MIT 许可证。本项目通过本机 `opencode serve` 的本地 API 和数据库工作，仓库不包含 OpenCode 源码副本；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **免费模型**：OpenCode Zen 的免费模型受 [OpenCode 服务条款](https://opencode.ai/legal/terms-of-service)约束，MIT 许可证不覆盖这部分。官方明确表示免费模型只供 OpenCode 官方客户端使用，第三方应用或直接 API 调用会被拒绝。
- **当前限制**：本版本只筛选以 `-free` 结尾的模型，不支持 BYOK 或付费模型；公开分发前应先确认是否符合 OpenCode 最新政策，或改成使用用户自己的 API key/付费模型。不要把本项目宣传成“免费模型官方入口”。

## 快速开始（下载后）

前置：Node.js >=22.13；已安装并登录 OpenCode；本机已有 `opencode.db`。

1. 确认 `config.json` 的 `upstream.bin` 指向 opencode（默认 `~/.opencode/bin/opencode`）。
2. 在项目目录运行 `node server.mjs`（运行时零 npm 依赖，不需要先 `npm install`）。
3. 浏览器打开 <http://127.0.0.1:4090>。

截图功能仅支持 WSL + Windows；三个自定义 subagent 不在仓库内，缺少时核心聊天可用，但对应编排能力不完整。只有修改 CSS 才需要 `npm install && npm run build:css`。

## WSL 日常启动（可选）

以下 `.vbs` / `.cmd` 和 systemd unit 是作者本机的可选集成，不在仓库内；普通用户用上面的 `node server.mjs` 即可。

双击桌面上的 **`AI Console.vbs`**（推荐，零控制台窗口）。

出问题时用 **`AI Console (debug).cmd`** —— 那个会显示输出和日志。
不要用 `.cmd` 当日常启动器，它会闪一个黑框。

服务由 **systemd user unit** 托管（`~/.config/systemd/user/aiconsole.service`），
不是靠 `nohup`/`setsid` —— 那两种方式经 `wsl.exe` 启动时进程会跟着一起被收走。

首次启动 WSL 冷启动可能要十几秒。之后重复双击不会起多份服务。

## 停止

关掉浏览器窗口不会停服务。要彻底停：

```bash
systemctl --user stop aiconsole.service
```

其他常用命令：

```bash
systemctl --user status  aiconsole.service    # 看状态
systemctl --user restart aiconsole.service    # 重启
journalctl --user -u aiconsole.service -n 50 --no-pager   # 看日志
tail -f ~/.local/state/aiconsole.log          # 看服务自己的输出
```

服务已 `enable`，WSL 启动时会自动拉起。

## 结构

```
ai-console/
├── config.json      所有可调参数，无写死的绝对路径
├── server.mjs       主服务（零 npm 依赖，只用 Node 内置模块）
├── M0-probe.mjs     可行性探针，改完环境后可以复验
├── M1-test.mjs      数据层命令行验证
├── M4-test.mjs      跑一个真任务（会派 3 个子代理，约 15 分钟）
├── M4-verify.mjs    离线复验 M4 各项能力（读 M4-test 存的事件流，秒出）
├── M5-polish-test.mjs 交互打磨项逐条验证
├── M6-test.mjs      历史记录接口 + 前端渲染（vm + 最小 DOM 真跑）
├── M7-md-test.mjs   Markdown 渲染器单元测试（含 XSS 与真实样本）
├── M8-test.mjs      三个 subagent 的定义、权限、模型选择与实派验证
├── M9-toolgroup-test.mjs  工具折叠纯函数 planToolGroups 单元测试
├── M10-diff-test.mjs   LCS 行级 diff + diff 卡/错误卡渲染单测
├── M11-search-test.mjs CJK bigram 分词 + FTS5 跨会话全文搜索单测
├── M12-term-test.mjs   术语卡片（用户选词 / 浮层按钮 / 侧边卡片）单测
├── lib/
│   └── output.mjs   汇总落盘（会话结束写 output/）
├── lib/
│   ├── paths.mjs    路径解析 —— 整个文件夹能随便搬的基础
│   ├── db.mjs       只读 opencode.db
│   ├── sse.mjs      上游 SSE 客户端（断线自动重连）
│   ├── normalize.mjs 事件 → UI 状态
│   └── models.mjs   免费模型运行时解析
├── public/
│   └── index.html   界面（内联 CSS/JS）
└── output/          汇总结果，桌面有快捷方式，随时可删
```

## 构建栈：Tailwind v4 + DaisyUI v5

界面正从手写 CSS 迁到 **Tailwind v4.3.3 + DaisyUI v5.7.47**（`npm i -D`，~5MB node_modules）。

### 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 依赖：`tailwindcss` `daisyui` `@tailwindcss/cli` |
| `src/input.css` | `@import "tailwindcss"` + `@plugin "daisyui"` + 信号台色板（`@theme`）|
| `tailwind.config.js` | 内容扫描路径 `./public/**/*.{html,js}` |
| `public/app.css` | 构建产物：`npx tailwindcss -i src/input.css -o public/app.css` |

DaisyUI 主题是 `signaldesk`（跟色板一致），`<html data-theme="signaldesk">` 激活。

### 灰度铺开（不要一次性全换）

1. ✅ 截图管理面板（工具栏「截图」）
2. ✅ 历史抽屉（搜索框 `input input-bordered`、按钮 `btn`、徽标 `badge`——子代理徽标是信号色）
3. ✅ 环境面板 / 子代理模型面板（`select`、状态徽标、保存按钮）
4. ⏳ 主区 —— **不换 DaisyUI**：它是自定义的"信号台"结构（会话脊柱线、缩进层级），
   DaisyUI 没有对应组件，保持手写。

每换一块都要：截图对比 → 回归测试 → 全绿才进下一块。

### 打开资源管理器要置顶

`/api/screenshots/open` 不只是 `spawn explorer.exe` —— 那样窗口会开在 AI Console 后面。
`SetForegroundWindow` 从后台进程调会被 Windows 拒绝（防焦点劫持），
要用 `SetWindowPos(HWND_TOPMOST → HWND_NOTOPMOST)` 才能真正抬上来。
脚本在 `tools/open-shots-front.ps1`。

### 加 import / 改选择器后必须 grep 验证

`import { … } from 'node:fs'` 漏 `rmSync` 那次就是血案 —— 字符串替换"静默失败"，
没报错但代码没变。以后凡是改 import、改 CSS 选择器这类容易失配的，
替换完必须 grep 一遍确认真的写进去了。

### 改完类名后必须重新构建 + 重启

Tailwind 只生成"被扫描到的"类（tree-shake）。新用了 DaisyUI 类之后：

```bash
npx tailwindcss -i src/input.css -o public/app.css
systemctl --user restart aiconsole.service
```

### 截图管理面板

工具栏「截图」。显示当前路径、按日期分组的张数与大小；「在资源管理器打开」
弹 Windows 资源管理器；「清空」点一次变"再点一次确认"，二次点击才删 `.png`
（保留日期目录结构）。

三个后端接口：`GET /api/screenshots`、`POST /api/screenshots/open`、`POST /api/screenshots/clear`。

⚠️ **WSL 的 PATH 里没有 `explorer.exe`**，spawn 要用全路径 `/mnt/c/Windows/explorer.exe`，
否则 `spawn ENOENT`。而且它的错误只在异步 `error` 事件里出 —— 同步 try/catch 抓不到，
得先 `ps.on('error', ...)` 再 `unref()`，不能还没监听就返回 ok。

### 这一路上踩的坑（都写代码注释里了）

**① `loadStatic()` 的白名单。** `server.mjs` 里它写死了
`['index.html','app.js','style.css']`。**新增任何静态文件一律走 index.html 兜底**
（`staticCache.get(f) ?? staticCache.get('/')`）。
我把 `app.css` 挂了 `<link>` 之后主题一直不生效，查了级联、@layer、@media dark、
缓存，最后发现浏览器收到的根本不是 CSS —— 是 index.html。改白名单才通。
**以后加静态文件先加白名单。**

**② ESM 的命名导入要逐个写。** `import { … } from 'node:fs'` 里漏了 `rmSync`，
调用时 `rmSync is not defined`，被 `catch{}` 吞掉，表现为"接口返回了但什么都没删"。
这类"静默失败"之前也出过几次 —— **凡是加 import，替换后一定再 grep 一遍确认**，
别信"替换成功"的提示。

**③ `@plugin "daisyui/theme"` 的 `prefersdark`。** 设 `true` 会把主题包进
`@media (prefers-color-scheme: dark)`，系统不是 dark 就整个主题失效。
我们靠 `<html data-theme>` 显式激活，所以设 `false`。

**④ Tailwind v4 的 CLI 是单独的包。** 主包 `tailwindcss` 不再带 `tailwindcss` 命令，
要另外装 `@tailwindcss/cli`，否则 `npx tailwindcss` 报
"could not determine executable to run"。

## 汇总落盘

主会话每跑完一轮（`session.idle`），服务端就把它的**最后一条回复**写进 `output/`：

```
output/
├── 2026-10-06-1626-用 researcher agent 调研一个方向：HTTPS 证书为什么需要.md
└── index.md      ← 自动生成的目录页
```

文件头是元信息（会话 id / agent / 模型 / 完成时间 / 子代理清单），`---` 之后是正文。
桌面快捷方式「AI Console - 汇总结果」指向这个目录。

几个设计决定：

- **一个会话一个文件，再次 idle 时覆盖**，不是每次新增 —— 避免刷屏。
- 内容取自**只读数据库**而不是内存态，所以页面没开也能写。
- 触发点是 `session.idle` 而不是 `step-finish`：idle 保证后面不会再有正文增量。
- 只写主会话（有 `parent_id` 的是子代理，不单独落盘），空产出不写文件。
- 落盘失败只打日志，不影响正常使用。

⚠️ 库里 `session.model` 是 **TEXT 列存 JSON 字符串**（`{"id":"...","providerID":"..."}`），
不是对象。直接插值会得到一整串 JSON —— 要先 `JSON.parse` 再取 `.id`。

## 环境面板（MCP / Skills，只读）

工具栏「环境」按钮，只显示状态，**没有任何启停或编辑入口**（这是硬约束）。

数据来自 `/api/mcp` 和 `/api/skills`。后者读 `SKILL.md` 的 frontmatter 时
**必须处理 YAML 块标量**（`description: |` / `>`）：值在下面几行缩进里，
只读第一行的话 `humanizer-zh` 的描述会变成 `"|"`。

## 刷新回填

之前刷新页面后主区是空的 —— 实时区只靠 SSE 事件，而 SSE 只在页面打开后才推。
现在启动时会调 `hydrate()`：从 `/api/history/list` 取最近的主会话，
连同它的子会话，逐个 `/api/history` 拉回来，**重放成和 SSE 同形状的事件**再喂给渲染层。

所以 `/api/history` 返回的每个 part 都必须带 `sessionID` 和 `messageID`，
缺了就挂不到对应会话和消息上，回填会静默失效（M6 有专门检查这条契约）。

- 每个会话最多回放 40 条消息，避免大会话（实测有 500+ 消息的）把页面卡住
- 只重放 `text` / `reasoning` / `tool`；`step-*` 和 `compaction` 没有可渲染内容，跳过
- 回填出来的思考过程默认收起，否则一屏灰字

## 工具折叠（精简模式，M9）

顶栏「精简 | 全部」开关，默认精简，偏好存 `localStorage.ac-density`。

**规则**（用户拍板）：连续 ≥3 个"纯工作"消息收成一条汇总行
（`▸ 14 次工具调用 · bash×9 read×3 · 42s`），点击展开。
"纯工作" = 无正文、无派活、≥1 个已完成工具、无 task。
运行中/失败的工具永远保持可见，并打断连续段。
精简模式下 `todowrite` 整体隐藏（OpenCode 官方同样隐藏内部待办）。

实现参考 **opencode session-ui 的 `groupParts`**
（`packages/session-ui/src/components/message-part.tsx:663`）：线性扫描攒连续段，遇断点 flush。
我们照抄思路，但有一个关键差异，是实测踩出来的：

> opencode 把多个工具放在**同一条消息**里，所以它在消息内按 part 分组。
> 我们的实测显示 opencode serve 的事件流里**每个 `.msg` 只装一个工具**（`r0t1x0`），
> "工具墙"是连续多个 `.msg` 堆出来的。所以分组单位必须是**整条 `.msg`**，
> 在 `.s-body` 层级做，思考块（已折成一行）随消息一起折。

- 纯函数 `planToolGroups(seq)` 不碰 DOM，M9 有 16 条单测
- DOM 层 `regroupOne(scope)` **幂等重建**：先拆开所有 `.tgroup` 再按最新序列重包；
  用户手动展开的组按组首 pid 记在 `tgOpen` 里，重绘时恢复
- 历史回放（`openSession`）走同一套规则，只是输入从 DOM 换成 JSON parts
- 密度切换 = 置标志位 + 全部会话重新 regroup（幂等所以安全）

## 顶栏响应式（priority-nav 思路）

窗口变窄时，右侧工具区（消息/子代理/环境/子代理模型/截图/历史/清屏/精简全部）
按 `data-p` 优先级（小的先收）把放不下的挪进「⋯ N」下拉菜单；窗口拉宽再按相反顺序放回。

参考 `gijsroge/priority-navigation`（★765）的 `doesItFit/toDropdown/toMenu` 三段式，
两处本地化改动：

1. 原版收"DOM 末尾"的项 → 我们按 `data-p` 优先级收，**视觉顺序不用变**
2. 原版存 `breaks` 断点栈决定何时放回 → 我们用**试探性恢复**
   （放回去量一下 `scrollWidth <= clientWidth`，不行再收回来），状态更少

两个坑：#hdrTools 必须 `overflow:hidden` 才能量出溢出，但这会把 absolute 定位的下拉裁掉，
所以下拉用 `position:fixed`、打开时按 ⋯ 按钮的 `getBoundingClientRect()` 贴右下角。

## 历史详情续聊控件

历史详情底栏有独立的 **build/plan 切换 + 模型下拉**（`hfModeSeg` / `hfModel`），
默认跟随主界面当前值，可单独切换；续聊请求携带 `agent` 和 `model`。

## 历史装载到主界面

历史列表每行、历史详情底栏都有「装载到主界面」（`loadIntoMain(sid)`）：

清空主区 → 回放该会话全部消息 → 设 `rootSession` 为它 → 关抽屉 → 滚到底部
（`main.scrollTo({ top: main.scrollHeight })`），可以直接在主界面继续发消息。

回放 HTML 由 `buildReplayBody(j)` 统一生成，历史详情和主界面装载共用同一个函数，
避免两套渲染逻辑分叉（分叉过一次：详情少渲染 diff 卡/错误卡，装载出来就丢了）。
`rec.metaEl` 同步带上该会话的模型/耗时/token/费用。

## 布局：单栏居中

会话卡宽度 = 内容列宽度 + 两侧 padding，整张卡（脊柱/标题/正文/边框）居中；
底栏输入区用 `padding-inline:max(20px, calc((100% - var(--acw) - 64px)/2 + 22px))` 精确对齐同一列。
（ChatGPT/Claude 的单栏居中模式；早先"脊柱贴左、正文居中、边框拉满"的三层错位已消除。）

正文列宽由 CSS 变量 `--acw` 统一驱动（顶栏滑块 / `Alt+滚轮` / localStorage 均可改），
正文、消息块、会话卡、输入区全部引用它，所以滑块改的是**真实文本行宽**，
不是只拉外层容器。

## 工具 diff 视图与错误卡（F1）

`edit` / `write` 工具直接渲染 diff 卡：`edit` 是 `oldString` ↔ `newString` 的
**LCS 行级 diff**（自写，`Uint16Array` DP 矩阵，超过 9 万元格降级为公共前后缀裁剪 +
中段整块替换，防爆内存），`write` 渲染"全量写入 +N 行"。头部是 `路径 + 绿 +N / 红 −M`
徽章（对齐 opencode `session-diff.ts` 的 `DiffChanges`）。

两级压缩防止一屏刷屏：变化行 ±2 行以外的连续相同段折成 `⋮ N 行未变`；
显示行超 40 时第 30 行后收进 `⋮ 展开余下 N 行` 折叠。

失败工具渲染红色错误卡（参考 `tool-error-card.tsx`）：错误全文（截 500 字）+ 复制按钮，
复用代码块那套 `copyText`（clipboard API 拒绝时 execCommand 兜底）。

**踩过的坑**：我们的 opencode SDK **没有 `metadata.filediff`**（官方 session-ui 用的是
`@pierre/diffs` + 整文件 before/after），所以 diff 必须自己算；能算是因为
`edit.input` 里有完整的 `oldString`/`newString`、`write.input` 里有 `content`。
实时（`paintTool`）和回放（`toolRowHtml`）共用同一个 `toolExtraHtml(part)`，不分叉。

## 轻量语法高亮（F4）

自写 tokenizer，零外部依赖，支持 bash / js(ts/jsx/mjs) / py / json 五族。

实现要点：输入是 `esc()` **之后**的代码（引号已变成 `&quot;` / `&#39;`），
所以字符串正则要匹配实体；每种语言一张正则表，合成一条**主正则 + 交替分组**，
注释/字符串排在关键字前面，从左到右消费 —— 字符串和注释里的关键字不会被误染色。
只在 `<span>` 外包色，**不解转义**，XSS 面不变（M7 有断言）。

色板复用已有语义色：关键字 `--md-enum` 青、字符串 `--md-code` 绿、注释 `--muted`、
数字 `--md-strong` 橙、命令行 flag `--md-emph` 黄。

## 流式 Markdown 实时渲染（F2）

思路照 opencode `markdown-stream.ts` 用的 `remend`：流式期间把未闭合的标记
**临时补全再渲染**，而不是等停顿后突然从纯文本跳成 HTML。

`mdHeal(t)` 的修复规则（计数前先摘掉围栏内容，别数到代码里的标记）：
未闭合的 ``` 围栏补闭合行、奇数个 `` ` `` 补 `` ` ``、奇数个 `**` 补 `**`、
奇数个 `~~` 补 `~~`、行尾半截 `[text](url` 补 `)`。

渲染策略：`paintLiveMd()` 每 120ms 最多重渲染一次（限帧），
用户在块内选中文字时跳过该帧（不打断选择）；停顿 350ms 后仍由 `scheduleMd`
用**原样** `md(full)` 正式渲染一次。

## 内容列宽度可调（F6）

两个诉求触发的改动：**滚到底时最后一条消息悬在屏幕中段**（`#main` 底部原来有 `28vh`
的 padding），以及**左右空白不可调**。

- 底部 padding `28vh → 12vh`：最后一条消息距视口底 ~114px（950px 视口实测），
  既贴底又留呼吸位
- 内容列宽度改由 CSS 变量 `--acw` 驱动（默认 `92ch`，范围 `60ch–130ch`）：
  `#main>.session` 的 `max-width`、`.s-body/.c-body` 的 `max-width`、底栏输入区的
  `padding-inline` 三处都引用它，所以**输入框和正文永远对齐同一列**

控件两套（参考两个成熟实现）：

| 来源 | 借鉴点 |
|---|---|
| Obsidian 内置 **Readable line length** | 设置页滑块形态：range + 当前值显示 + 一键恢复默认 |
| **obsidian-corset**（Alt+滚轮实时调宽） | 只改一个 CSS 变量、即时生效、不重排布局 |

- 顶栏「宽度」按钮 → 弹出面板：滑块 60-130ch、当前值、"恢复 92ch"、快捷键提示
- **Alt+滚轮**上下快调（每次 ±2ch，带 60/130 clamp；输入框里不拦，免得跟换行打架）
- 偏好存 `localStorage.ac-w`，刷新保持；`Esc` 关面板

M5 有 9 条断言覆盖（含「三处都引用变量」和「底部留白降下来」）。

## 跨会话全文搜索（M11）

历史抽屉顶部输入框升级成**全库搜索**：搜所有历史会话的正文，不只是标题。

### 为什么必须自己写分词（实测，别改）

SQLite 自带的两个分词器对中文都不够用，M11 里留了对照实验：

| 分词器 | 实测结果 |
|---|---|
| `unicode61`（默认） | 中文查询**全废**。「优先级」「导航」「宽度」命中数全是 0——它把一整串汉字当一个 token |
| `trigram` | 「优先级」命中，但「导航」「宽度」命中 0——**要求查询 ≥3 字符**，而中文两字词太常见 |
| **bigram（本项目方案）** | 两字词全部命中 |

方案：入库时把汉字切成**重叠 bigram**（「优先级导航」→ `优先 先级 级导 导航`），查询时切同样的
bigram，用 FTS5 phrase 查询串起来。英文/数字按词切，照常命中。单字查询退回 `LIKE '%字%'`。

### 零污染

索引是**独立文件** `~/.ai-console/search.db`，`opencode.db` 全程只读（项目铁律）。
用「源库 mtime + size + 最大 part 时间」当指纹，变了才全量重建（实测 2313 条 / 1.25MB 正文，<400ms）。
M11 有断言检查用户库里没有多出 `doc`/`meta` 表。

### 交互

结果按片段展示：会话标题 + agent 徽章 + **命中词高亮** + 相对时间。
点一下跳进那条会话，滚到具体消息、整块闪一下、块内再高亮所有命中词（复用会话内搜索的 Highlight API）。

## 术语卡片（M12）

给生词做「选中即查」+ 侧边卡片，摆脱线性对话。

⚠️ 后端实现说明（别被文案骗了）：`POST /api/explain` 会在 **OpenCode 里真的建一个会话**
（`POST /session`，标题 `term-<词>`），发一条消息，拿完答案在 `finally` 里删掉。
所以它不是子 Agent，只是一个用完即删的一次性会话；`termSessions` 这个 Set 用来
让汇总落盘跳过它，否则每次选词都会在 `output/` 留一个 `term-*.md`。

### 为什么不标记，让用户自己选

第一版让 AI 主动把生词用 `{{词}}` 包起来（全局 `AGENTS.md` 加输出规则，`md()` 渲染成
`<span class="term">`）。实机用下来是个败笔，已推翻：

- AI 猜不准「用户不认识哪些词」，标多了满屏下划线，标少了要查的漏掉；
- 输出被标记规则带偏，讲解时冒出裸露的 `{{N-gram}}` 这类半成品；
- 规则写进全局 `AGENTS.md` 会污染所有无关会话。

现在**取消 AI 标记**（全局规则已删除、`md()` 不再解析 `{{}}`），改成
**Obendorf 式 links-on-demand**：正文保持干净，用户自己用鼠标框选/双击，解释在需要时按需生成。

### 交互

| 借鉴 | 做法 |
|---|---|
| **Obendorf**（ACM links-on-demand 研究） | 静止时正文**完全无标记**；只有用户主动选词才浮出入口。常显高亮会让人「扫读找链接」而不是读正文 |
| **Readwise Quick Lookup** | 用 **LLM 结合上下文解释**，不用通用词典——化学课的 Mercury 和天文的 Mercury 答案不同 |
| **Curio / Context-Explain** | 开侧边卡片、**不跳走不打断**；可追问；可钉住 |

- `mouseup` / `dblclick` 捕获选区 → 光标处浮出「✦ 解释「词」」按钮（纯 CSS 定位 + JS 显隐）
- 点按钮：取该词所在段落当上下文 → `POST /api/explain` → 右侧滑出卡片流式显示讲解
- 后端建**一次性临时会话**同步问一句，用完立刻删（历史列表零残留）
- 卡片可追问、可钉住（钉住时 Esc 不关）；词不在上下文中时模型会主动说明而不是硬编

- **大纲侧条**：会话右缘每个用户提问一个刻度，hover 出摘要 tooltip，点击平滑跳转并高亮闪一下；
  滚动时按视口 35% 位置高亮当前所在消息。只给根会话建（子代理的提问不进大纲）。
- **消息级操作**：hover 消息浮出按钮 —— AI 回复「复制全文」、用户提问「编辑重发」
  （放回输入框尾部，改完直接回车）。复用 `copyText`。

⚠️ 顺手修了一个真 bug：`message.part.updated` **不带 role**，老代码 `ensureMsg(rec, part.messageID)`
拿不到角色，导致**用户提问被渲染成"AI 回复"**（截图里才看出来）。现在：
`message.updated` 把 role 存进 `msgRole` 缓存，part 事件从这里取；`hydrate()` 也改成
先补发一条 `message.updated` 再重放 parts。

## 会话内搜索（Ctrl+F）

`Ctrl+F`（**拦截浏览器默认**，用户拍板）在会话区右上弹搜索条：
输入即搜、`3/17` 计数、`Enter/↓` 下一个、`Shift+Enter/↑` 上一个、`Esc` 关闭。

高亮用 **CSS Custom Highlight API**（Baseline 2025，Edge/Chrome 105+），
参考 MDN 官方搜索高亮示例：`TreeWalker` 收文本节点 → 命中建 `Range` →
`CSS.highlights.set('ac-search', …)` 注册 → `::highlight()` 上色。

选它而不是包 `<mark>` 的原因：我们的 `md()` 会 `innerHTML` 重渲染，
流式更新随时冲掉 DOM 包裹；Range 高亮不动 DOM，失效了防抖 300ms 重算一遍就行。
命中若在折叠的思考/工具组里，跳转前先把祖先 `<details>` 逐层展开再 `scrollIntoView`。
不支持该 API 时降级为只计数 + 跳转。命中数上限 500 防超长会话卡死。

## 端口

| 端口 | 谁用 |
|---|---|
| 4090 | AI Console 界面（`UI_PORT` 环境变量可改，默认 4090） |
| 4096 | 它自己拉起的 `opencode serve` |

⚠️ 界面端口**不在 `config.json` 里**，只在 `server.mjs` 的 `UI_PORT = env || 4090`。
测试脚本请用同样的取法，别从 `config.json` 读 `ui.port`（读不到）。

## 设计方向：信号台

界面按 Anthropic 官方 skill `frontend-design` 的方法重做了一遍
（装在 `~/.config/opencode/skills/frontend-design/`，Apache 2.0）。
那个 skill 的核心要求是：**先定方向再动手**，并避开"AI 生成界面"的五种套路。

### 色板（6 个具名值）

| 名称 | 值 | 用途 |
|---|---|---|
| `graphite` | `#0F1319` | 底色，冷调石墨（不用纯黑 —— 纯黑是 AI 套路） |
| `slab` | `#161C24` | 输入区、一级面板 |
| `rule` | `#232B36` | 全部分隔线与边框 |
| `signal` | `#57E0C2` | **唯一强调色**，薄荷青 |
| `muted` | `#7C8896` | 标签、时间、计数 |
| `chalk` | `#E8EDF2` | 主文字 |

### 三条主张

1. **颜色只表示"此刻正在发生"**，不做装饰。静态内容一律灰阶，强调色用量封顶。
2. **层级靠字号、明度、留白建立**，不靠卡片边框和阴影。
3. **数据用等宽，叙述用无衬线**（`Cascadia Mono` / `Segoe UI Variable`），一眼分清哪些是机器吐的。

### 结构上的改动

改之前主界面是典型的 **SaaS 卡片套装**（`frontend-design` 点名的第 4 种 AI 套路）：
内容切成一模一样的圆角卡片、层级不分、全部套同一个阴影。改掉之后：

| 原来 | 现在 |
|---|---|
| 每个会话一个圆角卡片 + 阴影 | 会话是**区块**，左侧 2px 状态脊柱线，区块间用发丝线分隔 |
| 子代理是嵌套卡片 | 缩进 + **1px** 脊柱线（比主线细，用线宽表达层级） |
| 工具调用做成圆角 chip | **单行等宽**，长内容省略号截断 |
| 思考过程是紫色折叠块 | 缩进 + 1px 淡线，字号更小、颜色更灰 —— 明确是次要信息 |
| 每条消息都写"AI 回复" | 连续同角色时自动省略，标签只在角色切换处出现 |
| 顶栏一堆带框小药丸 | 压成 34px 窄条，`tag` 之间用 1px 竖线分隔 |

字体阶梯：会话标题 17px/600 → 正文 14.5px/1.72 → 标签 11px → 数据 11.5px。
正文限宽 78ch（表格放宽到 104ch，表格数据需要横向空间）。

### 刻意没做的

- 不用入场淡入上移、逐个卡片 hover 效果（`frontend-design` 说这是 AI 味最重的痕迹）
  动效只在回应操作时出现：展开/收起/运行中脉冲
- 阴影只给抽屉和悬浮面板，因为它们真的浮在内容之上
- 无障碍：`:focus-visible` 焦点环、图标按钮 `aria-label`、
  动画遵守 `prefers-reduced-motion`、正文对比度 ≥ 7:1

### 这一轮又修掉的几个问题

| 问题 | 原因 |
|---|---|
| 滚动条惨白刺眼 | 深色界面用系统默认滚动条。加 `::-webkit-scrollbar` + `scrollbar-color`，深色细窄、悬停才变亮 |
| 1400px 屏上内容只占左边 45%，右侧一大片空 | 内容左对齐不居中，看着像没做完。改成居中一根 940px 的柱子，顶栏/底栏跟着对齐 |
| "AI 回复"连着出现 40 次 | **真 bug**：`classList.contains('msg.ai')` —— `classList` 不接受复合选择器，会把 `'msg.ai'` 当成��个类名，永远匹配不到。要写 `contains('msg') && contains('ai')` |
| 表格被挤到换三行 | 限宽写在了**容器**上，表格继承同一个窄宽度 |

### 限宽的三层规则（很容易写套）

正文要限宽（78ch），但表格和代码块是数据、需要更多横向空间。写套了会出现两种错误：

```css
.s-body>*{max-width:78ch}          /* 1) 思考/工具/派活 限宽 */
.s-body>.msg-body{max-width:100%}   /* 2) 正文容器要放开 —— 否则它内部的表格继承同一个窄宽度 */
.msg-body>*{max-width:78ch}         /* 3) 限宽加在容器的子元素上 */
.msg-body>.md-tw,.msg-body>.md-pre{max-width:100%}   /* 表格/代码块例外 */
```

- ❌ `.msg-body:has(.md-tw){max-width:100%}` —— 会把同一条消息里的**正文一起撑满**
- ❌ 只写 2) 不写 3) —— 容器先被卡死，里面的表格永远突破不了

DOM 实测：容器 896px / 正文 610px / 表格 896px。

### 历史列表的取样窗口

`/api/history/list` 按更新时间倒序。**只取 80 条的话，主会话一多，子代理会话就被挤出窗口** ——
实测累积到 152 个主会话时，最新的子代理会话排在第 85 名，用户在历史列表里根本看不到它们。
UI 和 M6 测试都已改成取 300（接口上限）。

### 改样式时注意

- **改完必须重启服务**：`staticCache` 是启动时读的，不重启页面还是旧的
- 断言样式的测试要检查**意图**而不是 CSS 字面量。
  M5 之前写死了 `border-left:2px solid var(--border)`，换个变量名就误报
- 检查规则块时注意合并选择器：正则 `\.child\{` 会匹配到 `.session,.child{` 里的那个，
  必须要求它是独立成规则的（`(?:^|[};])\s*\.child\{`）

## Markdown 渲染（M7）

自己实现的 `md()`，不引外部库。支持：标题、`**粗**`、`*斜*`、`~~删~~`、行内代码、
围栏代码块、有序/无序/嵌套列表、任务列表、表格（含横向滚动）、引用、分隔线、
链接（只放行 `http(s)` / `mailto`，拒绝 `javascript:` 和 `data:`）。

安全顺序：**先 `esc()` 转义全部 HTML，再做 Markdown 解析**，所以模型输出里的
`<script>` 不可能变成真标签。代码块内容只转义一次（不能出现 `&amp;lt;` 这种双重转义）。

三个容易踩的点，都已修：

| 坑 | 原因 | 处理 |
|---|---|---|
| `##标题` 不识别 | 模型很爱在井号后不加空格 | `#{2,3}` 允许无空格；单个 `#` 仍要求空格，免得把 `#标签` 当标题 |
| `> 引用` 不识别 | `esc()` 已把 `>` 变成 `&gt;`，匹配要跟着改 | 匹配 `&gt;` |
| 实时输出没 Markdown，历史回放有 | 打字机走 `message.part.delta`，用 `textContent` 逐帧刷，把 `md()` 生成的 HTML 覆盖成纯文本 | 流式期间纯文本保证顺滑，增量停 350ms 后再用 `md()` 渲染一次（`scheduleMd`） |
| 实时正文没有任何 Markdown 样式（一墙灰字） | `.md` 类只挂在历史回放（`.rp-txt md`）上，实时正文块（`ensurePart`）没挂 | 实时正文块 `className = 'blk msg-body md'` |

### 标题层级与代码块（阶段 B）

- 标题层级拉开：h3(`#`)=1.32em 紫+下划线、h4(`##`)=1.16em、h5(`###`)=1.04em、h6=0.95em 转 muted
  （对齐 opencode session-ui `markdown.css` 的"前两级突出，后面弱化"思路）
- 代码块头部栏：`.md-code > .md-codebar(语言徽章 + 复制按钮) + .md-pre`。
  复制按钮 hover 才现、成功换 ✓（照 opencode `markdown.css:204-227` 的 `[data-slot="markdown-copy-button"]`）；
  `navigator.clipboard` + `execCommand` 兜底（合成事件/旧内核下 API 会拒绝）
- 语言徽章配色：bash 青 / js·ts 黄 / py 蓝 / json 绿 / css·html 紫
- 表格斑马纹 `tr:nth-child(even)`；已完成任务 `- [x]` 整行降透明（`:has`）
- ⚠️ 代码块多套一层 `.md-code` 后，必须同步放宽 `.msg-body` 的限宽选择器，否则被压窄（已处理）

**踩过的坑**：标题正则要一次抓全部井号再判定 —— 旧写法 `/^(#{2,3})\s*(\S)/` 优先匹配，
会把 `#### x` 的前三个 `#` 吃掉、剩下 `# x` 当正文。M7 有专门防退化断言。

### 语义染色（OpenCode 式）

参考 OpenCode 官方主题的 Markdown 配色
（`packages/tui/src/theme/assets/opencode.json` + `theme/index.ts` 的 `markup.*` scope 表），
给不同语义元素上不同颜色，全部用 CSS 变量定义在 `:root`：

| 元素 | 颜色 | OpenCode token |
|---|---|---|
| 标题 h3-h6 | 紫 `#9D7CD8` | `markdownHeading`（h3 带下划线 = 官方 heading.1 的 underline） |
| **粗体** | 橙 `#F5A742` | `markdownStrong` |
| *斜体* | 黄 `#E5C07B` | `markdownEmph` |
| `行内代码` | 绿 `#7FD88F` | `markdownCode`（代码块保持原色 = 官方 codeBlock 用 fg） |
| 引用 | 黄 `#E5C07B` | `markdownBlockQuote` |
| 无序列表圆点 | 橙 `#FAB283` | `markdownListItem` |
| 有序列表序号 | 青 `#56B6C2` | `markdownListEnumeration` |

M7 测试里有对应的防退化断言（搜「OpenCode 式语义染色」）。

⚠️ **改完 `public/index.html` 必须重启服务**：`staticCache` 是启动时读的，
不重启的话页面还是旧的（这个坑让我误判过一次）。

## 子代理模型选择

界面上「子代理模型」按钮，给 researcher / cross-checker / orchestrator 分别指定模型。

- **不选 = 跟随主 AI**：实现方式是**把 agent `.md` 里的 `model:` 字段删掉**，
  opencode 就会继承主会话的模型。
- 选了 = 往 `model:` 字段写 `opencode/<id>`，并且只接受免费白名单里的模型
  （传付费模型直接 400）。

**关键机制**：改完 `.md` 必须让上游重读。`opencode serve` 在启动时缓存 agent 列表，
改文件不重启是**不生效**的（实测：改完立刻查 `/agent` 仍是旧模型）。
解决办法是 `POST /global/dispose` —— 实测能触发热重载，**不用重启服务、不会杀掉已有会话**。

保存后接口会回读上游 `/agent` 的实际结果，UI 也按这个显示，不靠猜。

## 怎么看界面：Windows 侧截图

⚠️ **先说清楚这是谁的**：下面这个浏览器 profile 是 **OpenCode-Browser**，
属于你**另一个任务**（让 Agent 直接操控浏览器）。AI Console 只是**借用**它开一个
带调试端口的实例来截图。本项目自己的东西全在 `C:\Users\<你>\<项目目录>\`，
两者不要混。

### 为什么需要绕这一圈

playwright MCP 配的是 **CDP 连接模式**（去连已开着的 `127.0.0.1:9222`），
没有浏览器在跑就连不上。而就算用 Edge 的 `--remote-debugging-port` 拉起来，WSL 侧也连不上：

- Edge 的 CDP 只绑 **Windows 的 `127.0.0.1`**（`--remote-debugging-address` 在新版被忽略）
- WSL 虽然是 `networkingMode=mirrored`，但**够不到 Windows 的 loopback 绑定**
- 实测：Windows 侧 `curl 9222` 通，WSL 侧 `curl 9222` 不通
- Edge 自带的 `--headless --screenshot` 在 Edge 154 上不落盘

**能用的办法**：Windows 侧有 Node（`C:\Program Files\nodejs\node.exe`），
脚本在 Windows 里跑、连 CDP 的 WebSocket 截图、PNG 写到 Windows 目录，WSL 再读走。

### 目录

**WSL 侧（项目本体，全在这里）**

```
~/ai-console/          ← 本项目
├── server.mjs  config.json  public/  lib/  output/
├── screenshots\<日期>\          截图（按日期分目录，文件名带时间戳）
└── tools/shot.mjs                截图脚本（由 Windows Node 执行）
```

**Windows 侧（只有 20KB 的"门面"）**

```
C:\Users\<你>\<项目目录>\
├── launcher\AI Console.vbs          无黑窗启动器
├── launcher\AI Console (debug).cmd  带日志的调试版
└── ai-console.ico                   桌面图标（7 个尺寸）
```

桌面两个快捷方式：

| 快捷方式 | 指向 |
|---|---|
| `AI Console.lnk` | `wscript.exe "…\AI-Console\launcher\AI Console.vbs"`，图标用上面那个 .ico |
| `AI Console - 汇总结果.lnk` | `\\wsl.localhost\…\ai-console\output`，保持系统默认文件夹图标 |

### 为什么 Windows 侧还剩这几个文件

实测结论（都验证过，不是推测）：

| 能不能搬进 WSL | 结论 |
|---|---|
| `AI Console.vbs` | 能。`wscript.exe` 执行 `\\wsl.localhost\…\AI Console.vbs` 返回 exit=0 |
| `screenshots/` | 能。Windows Node 往 WSL 目录写文件成功 |
| `tools/shot.mjs` | 能。已搬，现在就是通过 UNC 路径执行的 |
| **`ai-console.ico`** | **不搬**。快捷方式图标从本地路径加载最稳，从 UNC 加载不可靠且慢 |
| **桌面 `AI Console.lnk`** | **不搬**。Windows 的入口，WSL 里没法放桌面图标 |

`.vbs` 也没搬是为了避免鸡生蛋：双击时 WSL 得已经在跑，而且 UNC 启动慢。
「门面」留在 C 盘是合理的 —— 它本来就是给 Windows 用的。

⚠️ `tools/shot.mjs` 现在通过 UNC 路径执行，路径计算必须用
`fileURLToPath` + `path.win32`。**不要用 `URL.pathname`** —— 它会把 UNC 主机名吃掉
（`\\wsl.localhost\Ubuntu\a\b` 变成 `/Ubuntu/a/b`），算出来的路径是错的。

### 用法

```bash
WSHOT='\\wsl.localhost\<发行版>\home\<你>\ai-console\tools\shot.mjs'
"/mnt/c/Program Files/nodejs/node.exe" "$WSHOT" \
  'http://localhost:4090' '' 3000 1300 1200 1 \
  "document.getElementById('subBtn').click()" 1200 cdp-check
#              url          输出  等待ms 宽 高 整页 截图前执行的JS 执行后等待ms 文件名标签
#                          留空 = 自动存到 screenshots\<日期>\<HHMMSS>-<标签>.png
```

四个坑：

1. **脚本路径和输出路径都得用 Windows 形式**（`C:\...`），用 WSL 路径会被解析成 `C:\mnt\c\...`
2. **就绪探测必须用 Windows 侧的 curl**。WSL 侧永远连不上 9222，用它判断会误判
3. **页面默认是空的**（新开标签没有历史回填），要验证实时区必须在页面里自己发消息
4. 这个 CDP 浏览器有时会自己退出。重新拉起约 1 秒 —— 复用已有 profile 所以很快
   （当初新建 profile 要 12 秒以上，那是 `aiconsole-cdp` 被删掉的原因）

### 已清理的临时目录

| 目录 | 状态 |
|---|---|
| `Temp\aiconsole-cdp\`（521MB） | 已删 —— 重复的 Edge profile，复用 OpenCode-Browser 了 |
| `Temp\aiconsole-cdp-hs\`（98MB） | 已删 —— `--headless` 方案失败后的废料 |
| `Temp\aiconsole-tools\` | 已删 —— 截图脚本已挪到 `AI-Console\` |

## 自建的三个 subagent（M8）

放在 `~/.config/opencode/agents/`，不是本项目内：

| agent | 模型 | 权限 | 干什么 |
|---|---|---|---|
| `researcher` | 默认跟随主 AI | 禁 edit/bash/write | 只读广度调研，强制五节输出（含"未能查证"） |
| `cross-checker` | 默认跟随主 AI | 禁 edit/bash/write | 对抗性审阅，专门找数据冲突和逻辑跳跃 |
| `orchestrator` | 默认跟随主 AI | 默认禁 task，白名单只放上面两个 | 拆解 + 派活 + 去重汇总 |

模型字段默认**不写**，即继承主会话模型 —— 要指定就用界面上的「子代理模型」按钮。

**为什么 cross-checker 要用另一个模型**：它和产出原结论的 agent 不同模型，才不会被原结论的
推理路径带跑。这是"跨模型 review"唯一能落地的免费组合 —— 两个都是 stealth 档，
**不保证底层不是同一家**，别对外宣称是真正的跨厂商。

⚠️ **新建 agent 定义之后必须重启服务**（`systemctl --user restart aiconsole.service`）——
新建的 `.md` 不重启就完全认不到（只会有内置的 7 个）。
但**改已有 agent 的内容**（比如 model 字段）不用重启，调 `/global/dispose` 即可热重载。

## 两条不能违反的规则

写代码或改配置时请守住：

1. **不要在代码里硬编码模型 id。** 全部走 `lib/models.mjs` 运行时解析；免费模型只是当前默认，使用时必须遵守 OpenCode 的服务条款。
2. **不要动 `config.json` 里的绝对路径。** `~/` 开头和相对路径是可移植写法，写死的 `/...` 会让整个文件夹搬不了家。

## M4 能力实测数据

一次真实任务（主 AI 派 3 个 general 子代理并行调研）的完整事件流，8334 个事件：

| 能力 | 实测 |
|---|---|
| 自动分裂 | 根 1 个 + 子 3 个，子会话都带 `parentID` 和 `agent=general` |
| 思考过程 | 47477 字，27 段带耗时（样例 3.9s），3659 个流式 delta |
| 状态灯 | `session.status` 给出 `busy`/`idle`，另有 `session.idle`/`session.error`/`permission.updated` |
| 完成判定 | 54 条 `time.completed` |
| 工具调用 | 225 个，`task` / `bash` / `websearch` / `webfetch` / `grep` / `read`，状态含 pending/running/completed/error |
| 正文 | 12972 字 |

**注意**：`subtask` part 在 SSE 里**不会出现**（实测 part 类型只有 tool/reasoning/text/step-start/step-finish）。
子卡标题直接取 `session.title`，它本身已含派活描述。

## 已知会踩的坑

### ⭐ 长会话卡死：7.5 万 DOM 节点 + 全量重排（实测数据）

装载本项目自己这条会话（**1607 条消息 / 6049 个 part / 6.3MB JSON / 7.5 万 DOM 节点**）时：

| 操作 | 修复前 | 修复后 |
|---|---|---|
| 首次布局 | 997ms | **32ms** |
| 拖宽度滑块每档 | 540~612ms（连拖 = 连续半秒主线程阻塞） | **11~19ms** |
| 装载总耗时 | 1.4s | 350ms |

根因不是 markdown 解析慢，是**每次改 `--acw` 都要给 7.5 万个节点重排一遍**。
修法就一行 CSS：

```css
.rp,.msg,.tgroup{content-visibility:auto;contain-intrinsic-size:auto 160px}
```

视口外的消息跳过布局和绘制，但**节点仍在 DOM 里** —— 这一点很关键：
会话内 Ctrl+F、跨会话搜索跳转、术语选词全都依赖消息节点存在。
所以没有上真虚拟滚动（TanStack Virtual 那类），它会把没渲染的消息摘出 DOM，
上面三个功能会跟着瞎。`contain-intrinsic-size` 的 `auto` 关键字让浏览器记住
每块上次渲染的真实高度，滚回去不跳。

对照组（只渲染尾部 200 条 + cv）是 4~5ms，但那样就丢了历史完整性，不划算。

### ⭐ 装载完一片空白：平滑滚动 + 估算高度打架

加上 `content-visibility` 后新问题：装载完滚到底，画面是**空的**。

两个原因叠加：
1. `#main` 有 `scroll-behavior:smooth`，`scrollTop` / `scrollIntoView` 都是**动画**滚动。
   一边平滑滚一边每帧重新定位，等于每次都把动画打断重来 → 永远停在半路。
2. 停住的位置正好在 `contain-intrinsic-size` 的**估算区**里，那里的块还没被渲染过。

修法：装载时先把 `scrollBehavior` 临时设成 `auto`，连着 10 帧吸底，
等真实高度把估算值替换掉再恢复平滑。

（自己踩的：中途试过"按最后一条消息元素 `scrollIntoView` 定位"，一样卡 ——
因为那个元素的 `offsetTop` 也是用前面兄弟的估算高度累加出来的，同样是虚的。）

### ⭐ 装载历史后，实时会话会重新长回主区

`S.clear()` 只清了注册表，**没摘 DOM**，也没断开全局 `EventSource`（所有会话共用一条）。
于是装载历史后，正在跑的那条对话连同它的子代理会 `ensureSession()` 整棵树挂回主区，
主区里出现两张 id 相同的卡；而且新卡会把旧卡里的消息也一起重渲染，DOM 越滚越大。

修法三件套：
1. `loadIntoMain` 先摘 DOM（`S.values().el.remove()` + 清 `#main` 的直接子元素）再清注册表；
2. 加 `pinnedSession`：主界面钉在某条会话上时，别的会话的渲染事件直接丢弃
   （状态类事件仍放行，顶栏连接状态和计数不失真），顶栏给一条「回到实时」的出口；
3. `ensureMsg` 建实时节点时先查有没有同 `data-mid` 的回放块 —— 有就**顶掉**它而不是追加，
   否则装载后仍在流式的那几条消息会显示两遍。

### ⭐ 宽度滑块"看着没反应"：角色选择器的优先级压过了统一规则

`.s-body>.msg-body{max-width:100%}`（2 个 class）是为了让消息块别被卡死，
但 `.msg.ai .msg-body{max-width:82ch}`（3 个 class）**优先级更高**，
于是 AI 正文被钉死在 82ch：容器跟着滑块变宽，文字行不变 —— 用户看到的
就是"文本框往左拉、右边还是空的"。

修法：`.msg.ai .msg-body` 改成 `var(--acw)`；
用户气泡和思考文本用 `min(var(--acw),72ch)` / `min(var(--acw),88ch)`，
既保住"比正文列短"的观感，又不会在 60ch 窄档反过来溢出正文列。

**这类 bug 静态断言看不出来**：grep `var(--acw)` 全部命中也会漏，
因为错的是"还有别的 max-width 赢了"。只能在浏览器里量像素：

```js
// 量三档下正文实际渲染宽度，必须单调递增且跟着 --acw 走
for (const n of [60, 92, 130]) {
  document.documentElement.style.setProperty('--acw', n + 'ch')
  console.log(n, document.querySelector('.msg.ai .msg-body').getBoundingClientRect().width)
}
```

修完实测：469px → 719px → 1016px（同段文字，两端截图在
`screenshots/2026-10-13/204500-正文A-B-*.png`）。

### 启动器

| 文件 | 用途 |
|---|---|
| `AI Console.vbs` | 日常用。双击零控制台窗口（`.vbs` 默认由 GUI 版 `WScript.exe` 打开，所以完全没有黑框）|
| `AI Console (debug).cmd` | 诊断用。能看到 wsl 输出和服务状态 |

`.vbs` 里的健康检查依赖 `sh.Run` 的退出码 —— `wsl.exe` 会透传 Linux 侧退出码，
`curl -sf` 连不上返回 7、健康返回 0，已实测。

### 改 `.cmd` 启动器时

- **必须 CRLF 行尾。** 纯 LF 会让 `goto :label` 失效，窗口秒闪秒关。
- **必须纯 ASCII。** 文件里有中文时，UTF-8 + cmd.exe 会把行解析搞乱，报莫名其妙的语法错。
- **不要用括号块 `if (...) else (...)`。** cmd.exe 在块内解析重定向有 bug，会报 `> was unexpected at this time`。
- **不要用 `set "CMD=wsl ... \"..."` 存命令。** cmd.exe 没有反斜杠转义，`\"` 会变成字面量。
- **不要用 `findstr "active"` 判断服务状态。** `inactive` 里含 `active` 子串，会误判成"在运行"。用健康检查接口。
- **命令全部写字面量**，不要放变量。

### ⭐ 读 `opencode.json` 会让工具死锁（最坑的一个）

AI 一旦用 read / bash 去读 `~/.config/opencode/opencode.json`，opencode 会触发配置 reload，
把当前 tool 调用挂起 —— **状态永远停在 `running`，并且阻塞整个会话**：
模型在等它返回，所以之后既没有思考过程也没有输出。

实测踩过：一个 `read` 卡了 46 分钟，一个 `bash` 卡了 5.6 分钟。文件本身完全正常
（684 字节、`cat` 秒读），是 opencode 工具层的问题，**我们修不了，只能检测和规避**。

已做的处理：
- `paintTool()` 显示工具运行时长；30s 变黄"偏慢"，120s 变红"疑似卡住"
- 点那个红字可中止**单个**会话（`POST /session/:id/abort`），救回来重问即可
- `/api/send` 注入的 system 里带一条禁止读该文件的规则
- 全局 `~/.config/opencode/AGENTS.md` 也加了同一条（影响 VSCode 里的会话）

### 测试脚本里的端口别写错

踩过：测试脚本把 `const UP = 'http://127.0.0.1:4096'` 写成上游 opencode 的端口，
而上游没有 `/api/*` 路由，opencode 就返回自己的网页（2884 字节、带 CSP）。
表现是"接口返回 HTML"，看起来像服务器坏了，其实是测试连错了端口。

`4090` 是本项目，`4096` 是上游 opencode。测试里请从 `config.json` 或
`process.env.UI_PORT || 4090` 取，别手写。

### 用 vm 跑前端脚本时的坑

`node:vm` 里顶层 `let` / `const` **不会挂到 global 对象**，
所以 `ctx.histData = data` 塞不进去 —— 脚本读的还是它自己的 `let histData = []`，
而且不报错，表现为"列表永远是空的"。想让脚本自己填数据，就调它内部的 `loadHist()`。

### 改 SSE 相关代码时

- **思考文本走 `message.part.delta`，不走 `message.part.updated`。** 后者只有两个态：创建时 `text:""`，完成时全文。
- **消息结束只能看 `message.updated` 里 `info.time.completed`。** 绝不能用"text 长度 > 0"当完成标志 —— reasoning 和 text 交错到达，早断会丢掉全部思考过程。
- **`spawn('opencode', ...)` 会 ENOENT。** 经 `wsl.exe` 起的非交互 shell 里 PATH 没有 `~/.opencode/bin`（`/etc/wsl.conf` 里 `appendWindowsPath=false`）。必须用绝对路径，配置项 `upstream.bin`。

## 权限审批（M13）

上游要授权时（默认 `external_directory` / `doom_loop` 会拦；bash、edit 默认直接放行），
会话头下方插审批卡（允许一次 / 总是允许 / 拒绝），顶栏亮 `⏸ 待授权` 徽章，标签页标题加 `⏸ N 待授权` 前缀。

- 数据流：SSE 实时事件 → 卡片；页面刚打开时用 `GET /permission` 回填（回填**不响铃、不弹 toast**）。
- 回复：`POST /api/permission/reply` → 上游 `POST /session/:id/permissions/:permissionID`，body `{response}`。
  实测 1.19 上游认 `{response}`（回显成 `reply`），无需 `remember`。
- 卡片清理只认 `permission.replied` 事件（终端里回复的也清，单一事实源），另有 10s 兜底防事件丢。
- 徽章点击：目标会话没装载时自动 `loadIntoMain` 再定位（权限常来自"没在看的会话"，实测踩过）。

**事件名两版（踩过）**：1.18 SDK 是 `permission.updated` / `{permissionID, response}`；
1.19 服务端实测是 `permission.asked` / `{requestID, reply}`。前端两个名字都监听、两种字段都认。

**「总是允许」的寿命**：规则活在上游进程内存里（官方文档：本 OpenCode 会话内有效）。
**重启 `aiconsole.service` 会连上游 serve 一起重启 → 待审批请求和已存规则全部蒸发**——改前端代码后的例行重启会清掉它们，别惊讶。

回归测试：`M13-perm-test.mjs`。

## 待办条（M14）

会话头下方的折叠条：`▸ 待办 3/7 · 进行中 1`，点开展示逐条状态（✓ 完成 / ▶ 进行中 / ○ 待办 / ✕ 取消）。

- 实时：`todo.updated` 是**整表快照**，直接覆盖重绘，不要做增量。
- 回填：首次见到某会话时 `GET /api/todo?sessionID=`（上游 `GET /session/:id/todo`，
  实测返回 `[{content,status,priority}]`，**没有 id 字段**——渲染不要依赖 id）。
  会话不在上游 / 没有待办时上游给 404，服务端返回 `{ok:false}`，前端静默跳过。
- 位置：审批卡排在待办条前面（审批更急）。精简模式隐藏的是消息流里的 todowrite 工具块，与这条横条不冲突。

回归测试：`M14-todo-test.mjs`。

## 告警：声音 + 系统通知（M15）

三档合成音（Web Audio 振荡器，无音频文件）：

| 档 | 音型 | 何时响 |
|---|---|---|
| perm | 三连音 659/880/988 | 有新授权请求（回填不响） |
| error | 低音 233/196 | 会话报错 |
| done | 两连音 523/784 | 根会话 busy→idle，且**窗口不在前台**时才响 |

- 系统通知：权限/出错/干完各一条，点击聚焦窗口并滚到对应会话；权限未授予时静默跳过。
- 防连响：perm/error 共享 4s 节流，done 单独 10s；权限按 id 去重本来就不会重复。
- 总开关：顶栏「告警 开/关」（localStorage `ac-alarm`，默认开）；开启瞬间试听一声音。
- 降级：没有 Web Audio / 通知被拒，一切静默不报错。
- 浏览器自动播放策略：用户先与页面有过交互才有声音，纯打开不点不会响。

回归测试：`M15-alarm-test.mjs`（假 AudioContext 录频率断言音型；裸环境不崩）。

## 会话撤回 / 分叉 / 压缩（M16）

会话头 hover 浮出三个操作；会话忙时点了会提示等它跑完。

- **撤回**（`POST /session/:id/revert`）：不带 messageID 时自动取最后一条有正文的用户消息。
  上游语义实测：消息不删除、只打标记（会话上 `revert.messageID`），**文件改动还原是单向的**
  —— 点「恢复消息」（`unrevert`）只恢复消息，不会把文件改回去。
  回退期间旧消息整段压暗 + 顶部琥珀横幅；**直接发新消息 = 确认回退**：上游会丢弃
  回退点之后的旧分支（逐条 `message.removed`），页面同步截断 DOM。
- **分叉**（`POST /session/:id/fork`）：不带 messageID = 整段复制成新会话（消息 id 全换新，
  原会话不动，标题带 `(fork #1)`）。带 messageID 时上游只复制该消息**之前**的内容（排他）。
- **压缩**（`POST /session/:id/summarize`）：用会话自己的模型摘要上下文，上游追加一条
  compaction 用户消息 + 一条摘要 assistant 消息；页面渲染成「⧉ 上下文压缩点」分隔线。
  注意会话对象的 model 字段是 `{id, providerID}`（不是 modelID）。
- 顺带修掉一个既有 bug：发送时的乐观气泡与真实消息重复显示（现在真实消息到达即替换）。

回归测试：`M16-session-test.mjs`（静态接线 + vm 跑 paintRevert 压暗/横幅断言 + 路由参数校验）。

## 子代理时间线 + 上下文健康度（M17）

根会话派出子代理后，卡片里出现一条时间线：每行一个子代理，横条 = 它活着的时段
（进行中脉动、出错变红），右侧标注时长 / 工具调用数 / 上下文占用百分比。

- 数据全来自事件流，不额外请求上游：`session.time.created` 定位起点，任何带 sessionID
  的事件推进右端，`tool` part 按 id 去重计数。
- 上下文水位取**最新一条 assistant 消息**的 `tokens.total - output - reasoning`
  （即提示词那侧，含缓存读/写）；上限从 `/api/health` 的模型 `limit.context` 取，
  模型不在免费白名单里时宁可不显示，也不编数字。
- 根会话头部的小胶囊显示自身 `ctx N%`：≥65% 变琥珀、≥85% 变红并提示可以压缩（接 M16）。
- 只有子代理真的在跑时才每秒推进条长，全部 idle 就停，不空转 CPU。
- 冷知识：上游重启（AI Console 重启会连带重启它）后，旧会话在新实例里
  `Session not found`——历史能看不能续，这是 opencode 1.19 的行为，不是本项目的坑。

回归测试：`M17-timeline-test.mjs`（normalize 聚合字段 + 前端接线 + vm 跑时长/词元格式化）。

## 主页 + 会话视图重构（M18）

四个长期体验问题，一次改完：子代理消息总沉在最下面；更新闪烁、输入框忽隐忽现；
刷新后不知道看的是不是上次那条对话、最后一段总有毛病；页面最底下永远是派活消息。

- **主页**：刷新不再自动重放上次会话。落地页给一张「继续上次」（localStorage 记的
  `ac-last-sid`，没有就取最新根会话）+ 最近根会话列表（子代理数 / 相对时间 / 运行中徽标，
  徽标来自 `/api/state`）。点会话 = 装载快照；输入框发送 = 新对话；顶栏「主页」随时回来。
- **只渲染一棵树**：主页可见时所有渲染事件丢弃；打开会话或新建会话后进入「焦点」，
  只允许该主会话和它的直接子代理进入主区，别的实时会话不再往这里长（计数/状态仍更新）。
- **身份条**：装载历史时，卡片头部下方显示「历史快照 · 标题 · 最后更新 · N 条消息」；
  会话还在跑时补一条「该会话仍在运行」，最后一条没生成完会标黄；跑完后提示改成
  「快照后已继续到最新」。运行中的最后两条消息回放时带 part id 与全文，
  实时事件到达后原块接管，不会出现空白气泡或重复内容。
- **子代理折叠**：子会话默认只留一行状态头（▸ + 名称 + agent），点标题展开；
  时间线右上「展开全部 / 收起全部」，点时间线行定位并展开对应子会话。
  子会话里的用户消息标签改成「派活指令」，也不再提供「编辑重发」。
- **滚动**：只有当前主会话的流式输出会吸底，子卡创建不再抢滚动位置；
  用户主动往上滚才取消跟随（程序吸底/内容变高不会被误判成"离开底部"）。
- **流式渲染**：增量期间只追加纯文本（`textContent`），停 350ms 后一次性渲染 Markdown；
  不再每 120ms 重建整段 `innerHTML`，代码块/表格不会一帧一个高度。
- 顺手修了启动竞态：模型解析请求加了 8s/6s 超时，前端发送 30s 超时；
  上游刚起来时 `/provider` 慢响应不会再让「正在创建会话…」无限卡住。

回归测试：`M18-home-test.mjs`（主页/身份条/折叠/滚动/流式的静态接线 + vm 跑时间格式化与折叠开关）。
真机验证：双 researcher 并行 6 分钟全程子卡收起、时间线正常；快速问答结束时吸底 gap=0；
运行中从主页重新打开（历史快照 + 实时续写）无空白气泡、无重复消息。

## 测试与副作用

离线静态测试：`npm test`（M7 / M9 / M10 / M18，不访问服务或数据库）。

其余 M0/M1/M4–M6/M8/M11–M17 会连接本机 AI Console、`opencode serve` 或数据库，其中 M1/M4/M5/M8 会在真实数据库里创建测试会话并写入 `output/`，M6 会清空 `screenshots/`。不要在保存重要会话的数据库上直接跑；先备份 `opencode.db`，跑完按需清理测试会话和产物。测试输出可能包含本机会话标题/目录，勿直接公开日志。

## 数据来源

| 功能 | 来源 |
|---|---|
| 实时格子、思考过程 | 上游 SSE |
| 历史聊天记录 | 只读 `~/.local/share/opencode/opencode.db`；列表走 `/api/history/list` |
| MCP 状态 | `GET /mcp` |
| Skill 列表 | 读 `~/.config/opencode/skills/*/SKILL.md` |
| 免费模型 | `GET /provider`（含 reasoning 标记） |
| 待审批 / 待办 | `GET /permission`、`GET /session/:id/todo` |
| 权限回复 | `POST /session/:id/permissions/:permissionID`，body `{response}` |
| 撤回 / 恢复 / 分叉 / 压缩 | `POST /session/:id/{revert,unrevert,fork,summarize}`（实测见 M16 章） |
| 上下文水位 | 事件流 `message.updated` 的 `tokens`；上限来自 `/api/health` 的 `limit.context` |

`opencode.db` 是**拷贝后只读打开**的，绝不写入。你的 `opencode.json` 也不碰。

## 许可证

源码公开，采用 [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)：
允许个人、教育、研究等非商业用途，禁止商业使用；商业使用需另行取得授权。

这不是 OSI 开源许可证，属于 source-available。完整条款见 [LICENSE](LICENSE)。第三方组件与 OpenCode 的 MIT 声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。