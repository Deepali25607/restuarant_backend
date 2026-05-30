const { prisma } = require('./db')

// Single source of truth for what knobs the admin can tune.
// Each entry: key, label (for UI), type ('integer' | 'boolean'), default, range.
const ETA_SETTINGS = [
  {
    key: 'autoProgress',
    type: 'boolean',
    label: 'Auto-advance order status',
    help:
      'When off (recommended), orders only move from one stage to the next when a kitchen / admin user pushes them. When on, the system advances them automatically using the cadence below.',
    default: false,
  },
  {
    key: 'statusStepSeconds',
    type: 'integer',
    label: 'Auto-advance cadence',
    help:
      'Seconds between automatic status advances when auto-advance is on. Ignored otherwise.',
    unit: 'sec',
    default: 18,
    min: 5,
    max: 600,
    dependsOn: 'autoProgress',
  },
  {
    key: 'baseMinutes',
    type: 'integer',
    label: 'Minimum ETA',
    help: 'Floor for every order — the smallest number a customer will ever see.',
    unit: 'min',
    default: 8,
    min: 1,
    max: 120,
  },
  {
    key: 'perItemMinutes',
    type: 'integer',
    label: 'Default prep minutes per item',
    help: 'Used when a dish does not have its own prep time set.',
    unit: 'min',
    default: 4,
    min: 0,
    max: 60,
  },
  {
    key: 'perQueuedOrderMinutes',
    type: 'integer',
    label: 'Queue penalty per active order',
    help: 'Minutes added for each order currently in the kitchen ahead of this one.',
    unit: 'min',
    default: 0,
    min: 0,
    max: 30,
  },
  {
    key: 'maxMinutes',
    type: 'integer',
    label: 'Maximum ETA cap',
    help: 'Hard ceiling so a busy night does not show a 2-hour wait. 0 = no cap.',
    unit: 'min',
    default: 0,
    min: 0,
    max: 240,
  },
]

const ETA_DEFAULTS = Object.fromEntries(ETA_SETTINGS.map((s) => [s.key, s.default]))
const ETA_META = Object.fromEntries(ETA_SETTINGS.map((s) => [s.key, s]))

const SETTINGS_KEY = 'eta.config'

function coerce(spec, raw) {
  if (spec.type === 'boolean') {
    if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true
    if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false
    return spec.default
  }
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return spec.default
  if (n < spec.min) return spec.min
  if (n > spec.max) return spec.max
  return n
}

function parseStored(raw) {
  if (!raw) return { ...ETA_DEFAULTS }
  try {
    const parsed = JSON.parse(raw)
    const merged = { ...ETA_DEFAULTS }
    for (const spec of ETA_SETTINGS) {
      if (!parsed || parsed[spec.key] === undefined) continue
      const v = parsed[spec.key]
      if (spec.type === 'boolean' && typeof v === 'boolean') merged[spec.key] = v
      else if (spec.type !== 'boolean' && typeof v === 'number') merged[spec.key] = v
    }
    return merged
  } catch {
    return { ...ETA_DEFAULTS }
  }
}

// Settings are currently platform-wide (organizationId: null) — the
// Settings UI was removed, so the formula falls back to defaults and the
// per-org settings table is reserved for future use.
async function getEtaConfig() {
  const row = await prisma.setting.findFirst({
    where: { organizationId: null, key: SETTINGS_KEY },
  })
  return parseStored(row?.value)
}

async function updateEtaConfig(patch) {
  const current = await getEtaConfig()
  const next = { ...current }
  for (const [k, v] of Object.entries(patch || {})) {
    if (ETA_META[k]) next[k] = coerce(ETA_META[k], v)
  }
  const existing = await prisma.setting.findFirst({
    where: { organizationId: null, key: SETTINGS_KEY },
  })
  if (existing) {
    await prisma.setting.update({
      where: { id: existing.id },
      data: { value: JSON.stringify(next) },
    })
  } else {
    await prisma.setting.create({
      data: {
        id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        organizationId: null,
        key: SETTINGS_KEY,
        value: JSON.stringify(next),
      },
    })
  }
  return next
}

// Estimate ETA for a brand-new order given its items, current queue depth, and config.
// items: [{ qty, prepMinutes }]   queueAhead: integer
function estimateEtaMinutes({ items, queueAhead, config }) {
  const cfg = config || ETA_DEFAULTS
  const itemTime = (items || []).reduce((sum, it) => {
    const qty = Math.max(1, Number(it.qty) || 1)
    const per = it.prepMinutes && it.prepMinutes > 0 ? it.prepMinutes : cfg.perItemMinutes
    return sum + qty * per
  }, 0)
  const queueTime = Math.max(0, Number(queueAhead) || 0) * cfg.perQueuedOrderMinutes
  const raw = Math.max(cfg.baseMinutes, itemTime + queueTime)
  if (cfg.maxMinutes && cfg.maxMinutes > 0) return Math.min(raw, cfg.maxMinutes)
  return raw
}

module.exports = {
  ETA_SETTINGS,
  ETA_DEFAULTS,
  getEtaConfig,
  updateEtaConfig,
  estimateEtaMinutes,
}
