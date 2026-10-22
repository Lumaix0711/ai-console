#!/usr/bin/env node
// M19 · 模型策略离线测试：freeOnly 开关、免费/付费分层、隐私黑名单、排序
import { applyPolicy, pickModel } from './lib/models.mjs'

let fails = 0
const log = (...a) => console.log(...a)
const check = (name, ok, detail = '') => {
  ok ? log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`)
     : (fails++, log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`))
}

const policy = {
  freeOnly: true,
  requireReasoning: true,
  privacyBlocklist: ['nemotron-'],
  privacyReason: { 'nemotron-': '隐私黑名单' },
  tierOrder: [
    { match: ['space-bunny'], tier: 1, label: 'T1 zero-retention' },
    { match: [], tier: 2, label: 'T2 其他免费' },
  ],
}

const models = [
  { id: 'space-bunny-free', providerID: 'opencode', status: 'active', reasoning: true, costInput: 0, costOutput: 0, context: 100 },
  { id: 'big-pickle', status: 'active', reasoning: true, costInput: 0, costOutput: 0, context: 90 },
  { id: 'paid-model', providerID: 'openai', status: 'active', reasoning: true, costInput: 1, costOutput: 2, context: 200 },
  { id: 'nemotron-3-ultra-free', status: 'active', reasoning: true, costInput: 0, costOutput: 0 },
  { id: 'no-reasoning-free', status: 'active', reasoning: false, costInput: 0, costOutput: 0 },
  { id: 'inactive-free', status: 'inactive', reasoning: true, costInput: 0, costOutput: 0 },
]

log('\n【freeOnly=true】')
const onlyFree = applyPolicy(models, policy)
check('只保留免费模型', onlyFree.allowed.every(m => m.tier === 1 || m.tier === 2))
check('连不带 -free 的零价模型也算免费', onlyFree.allowed.some(m => m.id === 'big-pickle'))
check('付费模型不进入允许列表', !onlyFree.allowed.some(m => m.id === 'paid-model'))
check('隐私黑名单被拦', onlyFree.blocked.some(m => m.id === 'nemotron-3-ultra-free'))
check('无 reasoning 被拦', onlyFree.blocked.some(m => m.id === 'no-reasoning-free'))
check('非 active 被拦', onlyFree.blocked.some(m => m.id === 'inactive-free'))
check('tier1 排在最前', onlyFree.allowed[0]?.tier === 1, onlyFree.allowed[0]?.id)

log('\n【freeOnly=false】')
const all = applyPolicy(models, { ...policy, freeOnly: false })
check('免费模型仍在', all.allowed.some(m => m.id === 'space-bunny-free'))
check('付费模型被纳入', all.allowed.some(m => m.id === 'paid-model'))
check('付费模型单独标层', all.allowed.find(m => m.id === 'paid-model')?.tier === 100)
check('保留 providerID', all.allowed.find(m => m.id === 'paid-model')?.providerID === 'openai')
check('免费/付费标记正确', all.allowed.find(m => m.id === 'paid-model')?.free === false && all.allowed.find(m => m.id === 'space-bunny-free')?.free === true)
check('付费模型有明确标签', /付费/.test(all.allowed.find(m => m.id === 'paid-model')?.tierLabel || ''))
check('免费模型仍排在付费前', all.allowed.findIndex(m => m.id === 'space-bunny-free') < all.allowed.findIndex(m => m.id === 'paid-model'))
check('隐私黑名单仍然生效', all.blocked.some(m => m.id === 'nemotron-3-ultra-free'))

log('\n【pickModel】')
check('ref 精确匹配', pickModel(all.allowed, 'openai/paid-model')?.id === 'paid-model')
check('裸 id 兼容', pickModel(all.allowed, 'space-bunny-free')?.id === 'space-bunny-free')
check('providerID 指定时按 provider 匹配', pickModel(all.allowed, 'paid-model', 'openai')?.providerID === 'openai')
check('未授权模型返回 null', pickModel(all.allowed, 'gpt-not-here') === null)

log('')
if (fails) { log(`M19 失败 ${fails} 项 ❌`); process.exit(1) }
log('M19 全部通过 ✅')
