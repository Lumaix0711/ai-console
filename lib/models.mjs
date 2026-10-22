// 模型解析 —— 不硬编码任何模型 id
//
// 默认只读 config.models.allowedProviders（默认 opencode/Zen），不自动暴露本机
// 已登录的其他 provider 或本地 ollama。要接自己的 key，把 provider id 加进白名单。
// 免费/付费由运行时 id + cost 判断；免费模型限时提供，过期后自动消失，不需要改代码。
import { loadConfig } from './paths.mjs'

/** 从 /provider 拉全量模型元数据（含 capabilities.reasoning 和 cost） */
async function fetchFromServer(baseUrl, allowedProviders) {
  // 上游刚启动时 /provider 可能接受连接却迟迟不回；没有超时会让 /api/send 永久卡住
  const res = await fetch(`${baseUrl}/provider`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`GET /provider → HTTP ${res.status}`)
  const j = await res.json()
  const allow = new Set(allowedProviders?.length ? allowedProviders : ['opencode'])
  const connected = new Set(j.connected ?? [])
  const out = []
  for (const prov of j.all ?? []) {
    if (!allow.has(prov.id)) continue
    if (connected.size && !connected.has(prov.id)) continue
    for (const m of Object.values(prov.models ?? {})) {
      out.push({
        id: m.id,
        providerID: prov.id,
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
    providerID: 'opencode',
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
 * 不同模型的数据保留/训练政策不一样；这里按 config.tierOrder 排序，
 * 只是排序偏好，不是模型清单硬编码；模型列表永远来自运行时解析。
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

function isFreeModel(m) {
  return m.id.endsWith('-free') || (m.costInput === 0 && m.costOutput === 0)
}

export function applyPolicy(models, policy) {
  const blocked = []
  const allowed = []
  for (const m of models) {
    const free = isFreeModel(m)
    if (policy.freeOnly && !free) continue
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
    const providerID = m.providerID ?? 'opencode'
    const { tier, label } = free
      ? tierOf(m.id, policy)
      : { tier: 100, label: '付费模型（使用自己的额度）' }
    allowed.push({ ...m, providerID, free, tier, tierLabel: label })
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
  const providers = Array.isArray(cfg.models.allowedProviders) && cfg.models.allowedProviders.length
    ? cfg.models.allowedProviders
    : ['opencode']

  let models = []
  let source = ''
  let degraded = false
  try {
    models = await fetchFromServer(url, providers)
    source = `${url}/provider（${providers.join(', ')}）`
  } catch (e1) {
    if (!providers.includes('opencode')) {
      cache = {
        source: '全部失败', error: e1.message,
        allowed: [], blocked: [], degraded: true, lowWarning: true, fetchedAt: Date.now(),
      }
      return cache
    }
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
  const freeCount = allowed.filter(m => m.free).length
  const paidCount = allowed.length - freeCount
  cache = {
    source,
    allowed,
    blocked,
    freeCount,
    paidCount,
    degraded,
    // 降级（拿不到 reasoning 标记）时不能声称"已验证支持思考"
    reasoningUnknown: degraded,
    lowWarning: freeCount <= cfg.models.lowModelWarningThreshold,
    fetchedAt: Date.now(),
  }
  return cache
}

export function pickDefault(list) {
  return list[0] ?? null
}

/** 接受 provider/id（ref）或裸 id；只从白名单里选，找不到返回 null */
export function pickModel(allowed, rawModel, providerID = '') {
  const raw = String(rawModel || '')
  if (!raw) return null
  return allowed.find((m) => `${m.providerID}/${m.id}` === raw)
    ?? allowed.find((m) => m.id === raw && (!providerID || m.providerID === providerID))
    ?? allowed.find((m) => m.id === raw)
    ?? null
}