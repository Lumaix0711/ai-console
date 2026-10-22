// M7：Markdown 渲染器单元测试（md()）
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
const mk = () => ({ innerHTML:'', textContent:'', value:'', dataset:{}, style:{}, hidden:false,
  classList:{add(){},remove(){},contains(){return false},toggle(){}},
  appendChild(){},remove(){},addEventListener(){},setAttribute(){},removeAttribute(){},
  querySelector(){return mk()},querySelectorAll(){return []},closest(){return null} })
const ctx = createContext({
  document:{getElementById:mk,createElement:mk,querySelector:mk,querySelectorAll:()=>[],addEventListener(){},body:mk(),documentElement:mk()},
  EventSource:class{close(){}}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  CSS:{escape:s=>String(s)}, confirm:()=>false, alert(){}, TextDecoder,
  fetch:()=>Promise.reject(new Error('x')), window:null,
})
ctx.window = ctx
try { runInContext(js, ctx, { filename:'ui.js' }) } catch(e){ if(!/getElementById/.test(e.message)) throw e }
const md = ctx.md
if (typeof md !== 'function') { console.error('❌ md 没定义'); process.exit(1) }

let fails = 0
const t = (name, src, must, mustNot) => {
  const out = md(src)
  const ok = must.every(m => (m instanceof RegExp ? m.test(out) : out.includes(m)))
    && (mustNot || []).every(m => !(m instanceof RegExp ? m.test(out) : out.includes(m)))
  ok ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name}\n         出=${out.slice(0,180)}`))
}
console.log('【md() 渲染器】')
t('加粗', '这是**重点**内容', ['<strong>重点</strong>'], ['**'])
t('斜体', '这是*强调*和_强调_', ['<em>强调</em>'])
t('删除线', '~~不要~~', ['<del>不要</del>'])
t('行内代码', '用 `npm install` 安装', ['<code>npm install</code>'], ['`npm'])
t('围栏代码块', '前言\n```js\nconst a = 1;\n```\n后记', ['<pre class="md-pre"','<span class="md-lang" data-l="js">js</span>','tk-k">const</span>','md-codebar','md-copy'])
t('标题', '## 结论', ['<h4>结论</h4>'])
t('标题容忍无空格（模型常见）', '##选型经验', ['<h4>选型经验</h4>'], ['##'])
t('三标题无空格', '###细节', ['<h5>细节</h5>'], ['###'])
t('单个 # 仍要求空格（别误伤标签）', '#标签 不是标题', [], ['<h3>'])
t('标签不被当标题', '正文里的 #issue123 引用', [], ['<h3>'])
t('★ 四级标题带空格（不再剩个 #）', '#### 次要 H6', ['<h6>次要 H6</h6>'], ['<h5>#', '# 次要'])
t('★ 四级标题无空格不当标题', '####次要', [], ['<h5>', '<h6>'])
t('★ 五级标题带空格', '##### 五级', ['<h6>五级</h6>'], ['#'])
t('无序列表', '- 甲\n- 乙', ['<ul>','<li>甲</li>','<li>乙</li>'])
t('有序列表', '1. 第一\n2. 第二', ['<ol>','<li>第一</li>'])
t('嵌套列表', '- 外\n  - 内1\n  - 内2', ['<ul>','内1','内2'])
t('表格', '| 项 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |', ['<table>','<th>项</th>','<td>a</td>','<td>2</td>'])
t('链接', '看 [官方](https://example.com/x)', ['<a href="https://example.com/x"','target="_blank"'])
t('裸链接', '见 https://example.com/y 这个', ['<a href="https://example.com/y"'])
t('引用', '> 这是引用', ['<blockquote>'])
t('分隔线', '前\n\n---\n\n后', ['<hr>'])
t('任务列表', '- [x] 做完\n- [ ] 没做', ['type="checkbox"','checked'])
t('段落空行分开', '第一段\n\n第二段', ['<p>第一段</p>','<p>第二段</p>'])
t('段落内换行保留', '第一行\n第二行', ['<br>'])
console.log('【安全】')
t('★ 转义 HTML 标签', '<script>alert(1)</script>', ['&lt;script&gt;'], ['<script>alert'])
t('★ 转义属性注入（不能有裸引号逃逸）', '" onerror="alert(1)', ['&quot; onerror=&quot;'], ['onerror="'])
t('★ 拒绝 javascript: 链接', '[点我](javascript:alert(1))', [], ['<a href="javascript:'])
t('★ 拒绝 data: 链接', '[x](data:text/html,<script>)', [], ['<a href="data:'])
t('★ 代码块内不解析 markdown', '```\n**不是粗体**\n```', ['**不是粗体**'], ['<strong>不是粗体</strong>'])
t('★ 代码块内 HTML 只转义一次（不能 &amp;lt;）', '```\n<div>x</div>\n```', ['&lt;div&gt;x&lt;/div&gt;'], ['&amp;lt;'])
t('★ 引用块', '> 提醒\n> 第二行', ['<blockquote>','提醒'])
t('★ 引用块内也可含 markdown', '> **重点**', ['<blockquote>','<strong>重点</strong>'])
t('★ 中文斜体不误吞', '这是*强调*和_强调_', ['<em>强调</em>'])
t('★ 乘号不被当斜体', '2 * 3 * 4 = 24', [], ['<em>'])
console.log('【真实样本】')
const real = '## 结论\n\nCA 的本质作用不是"提供密钥"，而是提供一个第三方断言。\n\n| 项 | 值 | 来源 |\n|---|---|---|\n| 存储 | 双向认证 | RFC 5280 |\n\n**关键**：信任链。\n\n- 第一点\n- 第二点\n  - 嵌套\n\n> 提醒\n\n```\nopenssl x509 -text\n```'
const r = md(real)
t('真实报告：结构齐全', real,
  ['<h4>结论</h4>','<table>','<strong>关键</strong>','<ul>','嵌套','<blockquote>','<pre class="md-pre"','openssl x509'])
console.log('【OpenCode 式语义染色】')
// 配色取自 opencode 官方主题 packages/tui/src/theme/assets/opencode.json
const cssT = (name, needle) =>
  html.includes(needle) ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} —— 缺 ${needle}`))
cssT('标题紫 #9D7CD8（markdownHeading）', '--md-heading:#9D7CD8')
cssT('粗体橙 #F5A742（markdownStrong）', '--md-strong:#F5A742')
cssT('斜体黄 #E5C07B（markdownEmph）', '--md-emph:#E5C07B')
cssT('行内代码绿 #7FD88F（markdownCode）', '--md-code:#7FD88F')
cssT('引用黄（markdownBlockQuote）', '--md-quote:#E5C07B')
cssT('无序列表橙（markdownListItem）', '--md-list:#FAB283')
cssT('有序列表青（markdownListEnumeration）', '--md-enum:#56B6C2')
cssT('标题用色变量', '.md h3,.md h4,.md h5,.md h6,.rtext h3,.rtext h4,.rtext h5,.rtext h6{\n  margin:1.3em 0 .5em;font-weight:600;line-height:1.4;color:var(--md-heading);')
cssT('★ 实时正文挂 .md 类（否则样式全部落空）', "el.className = 'blk msg-body md'")

console.log('【阶段 B：Markdown 精修】')
cssT('h3 层级 1.32em（# 主标题）', '.md h3,.rtext h3{font-size:1.32em')
cssT('h4 层级 1.16em（## 章节）', '.md h4,.rtext h4{font-size:1.16em')
cssT('h5 层级 1.04em（### 小节）', '.md h5,.rtext h5{font-size:1.04em')
cssT('h6 弱化转 muted', 'color-mix(in srgb, var(--md-heading) 60%, var(--muted))')
cssT('代码块头部栏容器', '<div class="md-code"><div class="md-codebar">')
cssT('语言徽章带 data-l', 'class="md-lang" data-l=')
cssT('复制按钮存在', '<button class="md-copy" type="button">复制</button>')
cssT('复制按钮 hover 才现（opencode 式）', '.md-code:hover .md-copy,.md-copy:focus-visible{opacity:1}')
cssT('复制成功换 ✓（data-copied）', "b.dataset.copied = '1'")
cssT('复制用 clipboard API（含 execCommand 兜底）', 'navigator.clipboard?.writeText')
cssT('表格斑马纹', '.md tbody tr:nth-child(even){background:rgba(255,255,255,.015)}')
cssT('已完成任务整行降透明', '.md li:has(input[type=checkbox]:checked){opacity:.55}')
cssT('★ 代码块新结构同步放宽限宽', '.msg-body>.md-code')

console.log('【阶段 F4：轻量语法高亮】')
// highlight() 是纯函数，可以直接从 vm 拿出来跑真例
const hl = ctx.highlight
const hT = (name, cond, detail = '') =>
  cond ? console.log(`  [PASS] ${name}`) : (fails++, console.log(`  [FAIL] ${name} ${detail}`))
if (typeof hl !== 'function') { fails++; console.log('  [FAIL] highlight 没定义') }
else {
  hT('js 关键字染色', hl('const a = 1;', 'js').includes('<span class="tk-k">const</span>'))
  hT('js 字符串绿', hl('const a = &quot;x&quot;;', 'js').includes('<span class="tk-s">&quot;x&quot;</span>'))
  hT('js 注释灰', hl('// 注', 'js').includes('<span class="tk-c">// 注</span>'))
  hT('py 关键字', hl('def f(): pass', 'py').includes('<span class="tk-k">def</span>') && hl('def f(): pass', 'py').includes('<span class="tk-k">pass</span>'))
  hT('bash flag 黄', hl('grep --color x', 'bash').includes('tk-f'))
  hT('json 数字橙', hl('{&quot;a&quot;: 1}', 'json').includes('<span class="tk-n">1</span>'))
  hT('★ 字符串里的关键字不染', !hl('&quot;const const&quot;', 'js').includes('tk-k'), hl('&quot;const const&quot;', 'js'))
  hT('★ 注释里的关键字不染', !hl('// const', 'js').includes('tk-k'))
  hT('未知语言原样返回', hl('some text', 'rust') === 'some text')
  hT('★ XSS：转义不被破坏', !hl('&lt;script&gt;x&lt;/script&gt;', 'js').includes('<script>'))
}
cssT('md() 围栏接高亮', 'highlight(f.body, f.lang)')

console.log('【阶段 F2：流式 mdHeal 修复规则】')
const heal = ctx.mdHeal
if (typeof heal !== 'function') { fails++; console.log('  [FAIL] mdHeal 没定义') }
else {
  hT('未闭合围栏补闭合', heal('```js\nconst a=1').endsWith('\n```'))
  hT('已闭合围栏不动', heal('```js\nx\n```') === '```js\nx\n```')
  hT('未闭合行内代码补 `', heal('用 `foo').endsWith('`'))
  hT('未闭合粗体补 **', heal('这是**重点').endsWith('**'))
  hT('已闭合粗体不动', heal('这是**重点**') === '这是**重点**')
  hT('未闭合删除线补 ~~', heal('删掉~~这个').endsWith('~~'))
  hT('★ 围栏里的 ** 不算未闭合', heal('```\n**\n```') === '```\n**\n```')
  hT('半截链接补 )', heal('看[这里](https://a.b').endsWith(')'))
  hT('heal 后能被 md() 渲染成粗体', md(heal('这是**重点')).includes('<strong>重点</strong>'))
}
cssT('流式只刷纯文本', "pre.classList.add('plain'); pre.textContent = upto")
cssT('停顿后渲染 Markdown 并去掉纯文本态', "el.classList.remove('plain')")
if (js.includes('function paintLiveMd(')) { fails++; console.log('  [FAIL] 旧的逐帧 Markdown 重建还在') } else console.log('  [PASS] 旧的逐帧 Markdown 重建已移除')

console.log('')
console.log(fails === 0 ? 'md() 全部通过 ✅' : `${fails} 项失败 ❌`)
process.exit(fails ? 1 : 0)
