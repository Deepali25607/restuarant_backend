// Subscription / billing helpers.
//
// Plans are stored in the database (model Plan) and managed by the platform
// admin. To keep the rest of the codebase synchronous, we hold an in-memory
// cache of the plans, populated by loadPlans() at startup and refreshed after
// any plan mutation. Until the cache is loaded (or if the DB is unreachable)
// the built-in DEFAULT_PLANS act as a fallback so nothing breaks.

const { prisma } = require('./db')

const DAY_MS = 24 * 60 * 60 * 1000

const LIMIT_RESOURCES = ['tables', 'rooms', 'users', 'dishes']
const ORDER_CHANNELS = ['table', 'room', 'takeaway']

// Built-in plans. Seeded into the DB on first run and used as a fallback before
// the cache loads. Field shape matches the Plan model.
const DEFAULT_PLANS = [
  { id: 'trial', label: 'Trial', monthlyPrice: 0, durationDays: 14, billable: false, isTrial: true, maxTables: 5, maxRooms: 5, maxUsers: 6, maxDishes: 30, channelTable: true, channelRoom: false, channelTakeaway: false, contactSales: false, recommended: false, selfServe: true, sortOrder: 1, active: true },
  { id: 'monthly', label: 'Monthly', monthlyPrice: 2999, durationDays: 30, billable: true, isTrial: false, maxTables: 20, maxRooms: 20, maxUsers: 10, maxDishes: 100, channelTable: true, channelRoom: true, channelTakeaway: true, contactSales: false, recommended: false, selfServe: true, sortOrder: 2, active: true },
  { id: 'yearly', label: 'Yearly', monthlyPrice: 2499, durationDays: 365, billable: true, isTrial: false, maxTables: 30, maxRooms: 30, maxUsers: 15, maxDishes: 200, channelTable: true, channelRoom: true, channelTakeaway: true, contactSales: false, recommended: true, selfServe: true, sortOrder: 3, active: true },
  { id: 'enterprise', label: 'Enterprise', monthlyPrice: 0, durationDays: null, billable: false, isTrial: false, maxTables: null, maxRooms: null, maxUsers: null, maxDishes: null, channelTable: true, channelRoom: true, channelTakeaway: true, contactSales: true, recommended: false, selfServe: false, sortOrder: 4, active: true },
]

// Normalize a Plan row (DB or default) into the in-memory shape callers use.
function normPlan(row) {
  return {
    id: row.id,
    key: row.id,
    label: row.label,
    monthlyPrice: row.monthlyPrice || 0,
    durationDays: row.durationDays == null ? null : row.durationDays,
    billable: !!row.billable,
    isTrial: !!row.isTrial,
    contactSales: !!row.contactSales,
    recommended: !!row.recommended,
    selfServe: row.selfServe !== false,
    active: row.active !== false,
    sortOrder: row.sortOrder || 0,
    limits: {
      tables: row.maxTables == null ? null : row.maxTables,
      rooms: row.maxRooms == null ? null : row.maxRooms,
      users: row.maxUsers == null ? null : row.maxUsers,
      dishes: row.maxDishes == null ? null : row.maxDishes,
    },
    channels: {
      table: row.channelTable !== false,
      room: !!row.channelRoom,
      takeaway: !!row.channelTakeaway,
    },
  }
}

let PLAN_CACHE = null

function fallbackCache() {
  const m = {}
  for (const r of DEFAULT_PLANS) m[r.id] = normPlan(r)
  return m
}

// Current plan map (id -> normalized plan). Falls back to defaults pre-load.
function plans() {
  return PLAN_CACHE || fallbackCache()
}

// Load (and seed on first run) plans from the DB into the cache. Called at
// startup and after any plan create/update/delete.
async function loadPlans() {
  let rows = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } })
  if (!rows.length) {
    await prisma.plan.createMany({ data: DEFAULT_PLANS })
    rows = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } })
  }
  const m = {}
  for (const r of rows) m[r.id] = normPlan(r)
  PLAN_CACHE = m
  return m
}

function planExists(key) {
  return Boolean(plans()[key])
}

// The plan metadata object (with .label, .monthlyPrice, .durationDays,
// .billable, .limits, .channels). Falls back to the first plan if unknown.
function planMeta(key) {
  const c = plans()
  return c[key] || c.trial || Object.values(c)[0]
}

// All plans as an ordered array (for the platform-admin plan manager).
function planList() {
  return Object.values(plans()).sort((a, b) => a.sortOrder - b.sortOrder)
}

function planLimits(key) {
  return planMeta(key).limits
}

// Returns { tables, rooms, users, dishes } — tenant overrides win, else plan default.
function effectiveLimits(org) {
  const base = planLimits(org?.subscriptionPlan)
  return {
    tables: Number.isFinite(org?.maxTables) ? org.maxTables : base.tables,
    rooms: Number.isFinite(org?.maxRooms) ? org.maxRooms : base.rooms,
    users: Number.isFinite(org?.maxUsers) ? org.maxUsers : base.users,
    dishes: Number.isFinite(org?.maxDishes) ? org.maxDishes : base.dishes,
  }
}

function planAllowsChannel(key, channel) {
  return Boolean(planMeta(key).channels[channel])
}

// Returns { table, room, takeaway } — whether the tenant is *allowed* to offer
// each channel. Per-tenant override wins; otherwise the plan default.
function effectiveChannels(org) {
  const ch = planMeta(org?.subscriptionPlan).channels
  const override = {
    table: org?.tableOrderingAllowed,
    room: org?.roomOrderingAllowed,
    takeaway: org?.takeawayOrderingAllowed,
  }
  const out = {}
  for (const c of ORDER_CHANNELS) {
    out[c] = override[c] == null ? Boolean(ch[c]) : Boolean(override[c])
  }
  return out
}

class PlanLimitError extends Error {
  constructor(resource, limit) {
    super(`Plan limit reached for ${resource} (${limit}).`)
    this.code = 'plan_limit_exceeded'
    this.statusCode = 402
    this.resource = resource
    this.limit = limit
  }
}

function assertWithinLimit(org, resource, currentCount) {
  const cap = effectiveLimits(org)[resource]
  if (cap == null) return // unlimited
  if (currentCount >= cap) throw new PlanLimitError(resource, cap)
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS)
}

// Dates to stamp on the org when its plan changes / it's created.
function periodDatesFor(key, from = new Date()) {
  const p = planMeta(key)
  if (p.isTrial) {
    return { trialEndsAt: addDays(from, p.durationDays || 14), currentPeriodStart: null, currentPeriodEnd: null }
  }
  if (p.durationDays == null) {
    // No-expiry (enterprise-style): stamp a start for audit, no end.
    return { trialEndsAt: null, currentPeriodStart: from, currentPeriodEnd: null }
  }
  return { trialEndsAt: null, currentPeriodStart: from, currentPeriodEnd: addDays(from, p.durationDays) }
}

// Effective status — trial | active | expiring | past_due | expired | cancelled.
function effectiveStatus(org, now = new Date()) {
  if (!org) return 'expired'
  if (org.subscriptionStatus === 'cancelled' && !org.currentPeriodEnd) return 'cancelled'

  const p = planMeta(org.subscriptionPlan)

  // No-expiry, non-trial plan (enterprise-style) is always active.
  if (!p.isTrial && p.durationDays == null) return 'active'

  if (p.isTrial) {
    if (!org.trialEndsAt) return 'trial'
    const ms = new Date(org.trialEndsAt) - now
    if (ms <= 0) return 'expired'
    if (ms <= 3 * DAY_MS) return 'expiring'
    return 'trial'
  }

  // Paid plans
  if (!org.currentPeriodEnd) return org.subscriptionStatus || 'active'
  const ms = new Date(org.currentPeriodEnd) - now
  if (ms <= 0) return org.cancelAtPeriodEnd ? 'cancelled' : 'past_due'
  if (ms <= 5 * DAY_MS) return 'expiring'
  return 'active'
}

function daysUntilRenewal(org, now = new Date()) {
  const ref = planMeta(org?.subscriptionPlan).isTrial ? org?.trialEndsAt : org?.currentPeriodEnd
  if (!ref) return null
  const ms = new Date(ref) - now
  return Math.ceil(ms / DAY_MS)
}

function isAccessBlocked(status) {
  return status === 'expired' || status === 'past_due' || status === 'cancelled'
}

function billingSummary(org, now = new Date()) {
  const status = effectiveStatus(org, now)
  const meta = planMeta(org.subscriptionPlan)
  return {
    plan: org.subscriptionPlan,
    planLabel: meta.label,
    status,
    monthlyPrice: org.monthlyPrice || meta.monthlyPrice,
    trialEndsAt: org.trialEndsAt ? new Date(org.trialEndsAt).toISOString() : null,
    currentPeriodStart: org.currentPeriodStart ? new Date(org.currentPeriodStart).toISOString() : null,
    currentPeriodEnd: org.currentPeriodEnd ? new Date(org.currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: !!org.cancelAtPeriodEnd,
    daysUntilRenewal: daysUntilRenewal(org, now),
    blocked: isAccessBlocked(status),
  }
}

// ── Public pricing page ───────────────────────────────────────────────
function unlimitedOr(n, noun) {
  return n == null ? `Unlimited ${noun}` : `${n} ${noun}`
}

function planFeatures(p) {
  const channelLabels = { table: 'Dine-in (tables)', room: 'Room service', takeaway: 'Takeaway' }
  const channels = ORDER_CHANNELS.filter((c) => p.channels[c]).map((c) => channelLabels[c])
  return [
    unlimitedOr(p.limits.tables, 'tables'),
    unlimitedOr(p.limits.rooms, 'rooms'),
    unlimitedOr(p.limits.users, 'staff accounts'),
    unlimitedOr(p.limits.dishes, 'menu items'),
    `Ordering: ${channels.join(', ') || '—'}`,
    'Live orders, kitchen & cashier consoles',
    'Reports, loyalty & expenses',
  ]
}

function priceNoteFor(p) {
  if (p.contactSales) return 'Custom pricing'
  if (!p.billable) return p.durationDays ? `Free for ${p.durationDays} days` : 'Free'
  if (p.durationDays === 365) return 'per month, billed yearly'
  if (p.durationDays === 30) return 'per month'
  return `every ${p.durationDays} days`
}

// Plans a visitor can compare & subscribe to on the public signup page.
function publicPlans() {
  return planList()
    .filter((p) => p.active && (p.selfServe || p.contactSales))
    .map((p) => ({
      key: p.id,
      label: p.label,
      price: p.contactSales ? null : p.monthlyPrice,
      billable: p.billable,
      durationDays: p.durationDays,
      priceNote: priceNoteFor(p),
      contactSales: p.contactSales,
      selfServe: p.selfServe,
      recommended: p.recommended,
      limits: p.limits,
      channels: p.channels,
      features: planFeatures(p),
    }))
}

// Map an in-memory plan back to a Plan-model row payload (for create/update).
function planToRow(p) {
  return {
    id: p.id,
    label: p.label,
    monthlyPrice: p.monthlyPrice || 0,
    durationDays: p.durationDays == null ? null : p.durationDays,
    billable: !!p.billable,
    isTrial: !!p.isTrial,
    maxTables: p.limits?.tables == null ? null : p.limits.tables,
    maxRooms: p.limits?.rooms == null ? null : p.limits.rooms,
    maxUsers: p.limits?.users == null ? null : p.limits.users,
    maxDishes: p.limits?.dishes == null ? null : p.limits.dishes,
    channelTable: p.channels?.table !== false,
    channelRoom: !!p.channels?.room,
    channelTakeaway: !!p.channels?.takeaway,
    contactSales: !!p.contactSales,
    recommended: !!p.recommended,
    selfServe: p.selfServe !== false,
    sortOrder: p.sortOrder || 0,
    active: p.active !== false,
  }
}

// ── Coupons ───────────────────────────────────────────────────────────
// Compute the discount a coupon applies to `amount` (INR). Returns the
// discount amount (>=0, capped at amount).
function couponDiscount(coupon, amount) {
  if (!coupon || !amount) return 0
  if (coupon.discountType === 'flat') {
    return Math.max(0, Math.min(amount, coupon.discountValue || 0))
  }
  const pct = Math.max(0, Math.min(100, coupon.discountValue || 0))
  return Math.min(amount, Math.round((amount * pct) / 100))
}

// Validate a coupon against a plan. Returns { ok, reason }.
function couponUsable(coupon, planId, now = new Date()) {
  if (!coupon || !coupon.active) return { ok: false, reason: 'This coupon is not valid.' }
  if (coupon.expiresAt && new Date(coupon.expiresAt) < now) return { ok: false, reason: 'This coupon has expired.' }
  if (coupon.maxRedemptions != null && coupon.redemptions >= coupon.maxRedemptions) {
    return { ok: false, reason: 'This coupon has reached its redemption limit.' }
  }
  const scope = String(coupon.appliesToPlans || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (scope.length && planId && !scope.includes(planId)) {
    return { ok: false, reason: "This coupon doesn't apply to the selected plan." }
  }
  return { ok: true }
}

function formatInvoiceNumber(year, sequence) {
  return `INV-${year}-${String(sequence).padStart(4, '0')}`
}

module.exports = {
  DEFAULT_PLANS,
  LIMIT_RESOURCES,
  ORDER_CHANNELS,
  loadPlans,
  plans,
  planList,
  planExists,
  planMeta,
  planLimits,
  planToRow,
  effectiveLimits,
  planAllowsChannel,
  effectiveChannels,
  publicPlans,
  assertWithinLimit,
  PlanLimitError,
  periodDatesFor,
  effectiveStatus,
  daysUntilRenewal,
  isAccessBlocked,
  billingSummary,
  couponDiscount,
  couponUsable,
  formatInvoiceNumber,
  addDays,
  DAY_MS,
}
