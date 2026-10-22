// 免费模型解析 —— 不硬编码任何模型 id
//
// 为什么不能写死：官方文档里 13 个免费模型全部标注 "for a limited time"，
// 而且不公布任何到期日期（/zen/v1/models 只返回 created/id/object/owned_by 四个字段）。
// 更早版本的文档页列的免费模型列表还不一样（出现过 kimi-k2.5-free、minimax-m2.5-free）。
// → 每次启动都重新解析，过期模型自动消失，不需要改代码。
import { loadConfig } from './paths.mjs'

/** 从 /provider 拉全量模型元数据（含 capabilities.reasoning 和 cost） */
async function fetchFromServer(baseUrl) {
  // 上游刚启动时 /provider 可能接受连接却迟迟不回；没有超时会让 /api/send 永久卡住
  const res = await fetch(`${baseUrl}/provider`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`GET /provider → HTTP ${res.status}`)
  const j = await res.json()
  const out = []
  for (const prov of j.all ?? []) {
    if (prov.id !== 'opencode') continue          // 只认 Zen，不碰 ollama 等本地 provider
    for (const m of Object.values(prov.models ?? {})) {
      out.push({
        id: m.id,
        name: m.name ?? m.id,
        reasoning: !!m.capabilities?.reasoning,
        context: m.limit?.context ?? null,
        outputLimit: m.limit?.output ?? null,
        costInput: m.cost?.input ?? null,
        costOutput: m.cost?.output ?? null,
        status: m.status,
      })
    }
  }
  return out
}

/** 兜底：Zen 公开端点（无鉴权也能读，但拿不到 reasoning 标记） */
async function fetchFromZenPublic() {
  const res = await fetch('https://opencode.ai/zen/v1/models', { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`zen/v1/models → HTTP ${res.status}`)
  const j = await res.json()
  return (j.data ?? []).map(m => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: null,          // 公开端点不提供
    context: null,
    outputLimit: null,
    costInput: null,
    costOutput: null,
    status: 'active',
  }))
}

/**
 * 给每个模型打隐私等级。
 * 官方隐私章节只对两个模型明确写了 zero-retention（"does not use your data for
 * model training"），其余只写 "for a limited time" 没给豁免 —— 分开对待。
 * 注意：这是"排序偏好"，不是模型清单硬编码；模型列表永远来自运行时解析。
 */
function tierOf(id, policy) {
  for (const t of policy.tierOrder ?? []) {
    if (!t.match?.length) continue
    if (t.match.some(s => id.includes(s))) {
      return { tier: t.tier ?? 99, label: t.label ?? '' }
    }
  }
  const last = (policy.tierOrder ?? []).filter(t => !t.match?.length).pop()
  return { tier: last?.tier ?? 99, label: last?.label ?? '限时免费，数据政策未声明豁免' }
}

function applyPolicy(models, policy) {
  const blocked = []
  const allowed = []
  for (const m of models) {
    if (!m.id.endsWith('-free')) {                       // 必须明确标 free
      continue
    }
    if (m.status && m.status !== 'active') {
      blocked.push({ ...m, reason: `状态=${m.status}` })
      continue
    }
    const hit = (policy.privacyBlocklist ?? []).find(p => m.id.includes(p))
    if (hit) {
      blocked.push({ ...m, reason: policy.privacyReason?.[hit] ?? '隐私黑名单' })
      continue
    }
    if (policy.requireReasoning && m.reasoning === false) {
      blocked.push({ ...m, reason: '不支持思考过程（M4 面板需要）' })
      continue
    }
    const { tier, label } = tierOf(m.id, policy)
    allowed.push({ ...m, tier, tierLabel: label })
  }
  // 隐私等级优先，其次 reasoning 标记，最后上下文大小
  allowed.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    const ra = a.reasoning === true ? 1 : 0, rb = b.reasoning === true ? 1 : 0
    if (ra !== rb) return rb - ra
    return (b.context ?? 0) - (a.context ?? 0)
  })
  return { allowed, blocked }
}

let cache = null

export async function resolveModels({ baseUrl, force = false } = {}) {
  if (cache && !force) return cache
  const cfg = loadConfig()
  const url = baseUrl || cfg.upstream.baseUrl

  let models = []
  let source = ''
  let degraded = false
  try {
    models = await fetchFromServer(url)
    source = `${url}/provider`
  } catch (e1) {
    try {
      models = await fetchFromZenPublic()
      source = 'https://opencode.ai/zen/v1/models（公开端点，拿不到 reasoning 标记）'
      degraded = true
    } catch (e2) {
      cache = {
        source: '全部失败', error: `${e1.message} / ${e2.message}`,
        allowed: [], blocked: [], degraded: true, lowWarning: true, fetchedAt: Date.now(),
      }
      return cache
    }
  }

  const { allowed, blocked } = applyPolicy(models, cfg.models)
  cache = {
    source,
    allowed,
    blocked,
    degraded,
    // 降级（拿不到 reasoning 标记）时不能声称"已验证支持思考"
    reasoningUnknown: degraded,
    lowWarning: allowed.length <= cfg.models.lowModelWarningThreshold,
    fetchedAt: Date.now(),
  }
  return cache
}

export function pickDefault(list) {
  return list[0] ?? null
}