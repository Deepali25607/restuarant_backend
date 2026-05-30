// Subscription / billing helpers. Single source of truth for plan presets
// and for deriving the *effective* subscription status from an org's stored
// dates — so a stale `subscriptionStatus` field can't keep an expired tenant
// alive after the renewal date passes.

const DAY_MS = 24 * 60 * 60 * 1000

const PLANS = {
  trial: { label: 'Trial', durationDays: 14, monthlyPrice: 0, billable: false },
  monthly: { label: 'Monthly', durationDays: 30, monthlyPrice: 2999, billable: true },
  yearly: { label: 'Yearly', durationDays: 365, monthlyPrice: 2499, billable: true },
  enterprise: { label: 'Enterprise', durationDays: null, monthlyPrice: 0, billable: false },
}

// Per-plan resource quotas. `null` means unlimited. Tenant rows may override
// any of these via Organization.maxTables / maxUsers / maxDishes (see
// effectiveLimits below).
const PLAN_LIMITS = {
  trial:      { tables: 5,    users: 3,    dishes: 30 },
  monthly:    { tables: 20,   users: 10,   dishes: 100 },
  yearly:     { tables: 30,   users: 15,   dishes: 200 },
  enterprise: { tables: null, users: null, dishes: null },
}

const LIMIT_RESOURCES = ['tables', 'users', 'dishes']

function planLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.trial
}

// Returns { tables, users, dishes } — each value is a positive Int OR null
// (unlimited). Tenant overrides win; otherwise the plan default applies.
function effectiveLimits(org) {
  const base = planLimits(org?.subscriptionPlan)
  return {
    tables: Number.isFinite(org?.maxTables) ? org.maxTables : base.tables,
    users: Number.isFinite(org?.maxUsers) ? org.maxUsers : base.users,
    dishes: Number.isFinite(org?.maxDishes) ? org.maxDishes : base.dishes,
  }
}

// Throws an HTTP-shaped error when `currentCount` is at/over the limit for
// `resource`. Callers catch and translate to a 402 response.
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
  const limits = effectiveLimits(org)
  const cap = limits[resource]
  if (cap == null) return // unlimited
  if (currentCount >= cap) throw new PlanLimitError(resource, cap)
}

function planMeta(plan) {
  return PLANS[plan] || PLANS.trial
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS)
}

// Returns the dates that should be stamped on the org when its plan changes
// (or when it's first created). Caller still decides which fields to PATCH.
function periodDatesFor(plan, from = new Date()) {
  const meta = planMeta(plan)
  if (plan === 'trial') {
    return {
      trialEndsAt: addDays(from, meta.durationDays),
      currentPeriodStart: null,
      currentPeriodEnd: null,
    }
  }
  if (plan === 'enterprise') {
    // Enterprise: no auto-expiry. We still stamp a period start for audit.
    return {
      trialEndsAt: null,
      currentPeriodStart: from,
      currentPeriodEnd: null,
    }
  }
  return {
    trialEndsAt: null,
    currentPeriodStart: from,
    currentPeriodEnd: addDays(from, meta.durationDays),
  }
}

// Effective status — what the UI / login should treat as the truth.
// `org` is a row from prisma.organization.findX(). Returns one of:
//   trial | active | expiring | past_due | expired | cancelled
function effectiveStatus(org, now = new Date()) {
  if (!org) return 'expired'
  if (org.subscriptionStatus === 'cancelled' && !org.currentPeriodEnd) return 'cancelled'

  const plan = org.subscriptionPlan
  if (plan === 'enterprise') return 'active'

  if (plan === 'trial') {
    if (!org.trialEndsAt) return 'trial'
    const ms = new Date(org.trialEndsAt) - now
    if (ms <= 0) return 'expired'
    if (ms <= 3 * DAY_MS) return 'expiring'
    return 'trial'
  }

  // Paid plans
  if (!org.currentPeriodEnd) return org.subscriptionStatus || 'active'
  const ms = new Date(org.currentPeriodEnd) - now
  if (ms <= 0) {
    return org.cancelAtPeriodEnd ? 'cancelled' : 'past_due'
  }
  if (ms <= 5 * DAY_MS) return 'expiring'
  return 'active'
}

function daysUntilRenewal(org, now = new Date()) {
  const ref = org?.subscriptionPlan === 'trial' ? org.trialEndsAt : org?.currentPeriodEnd
  if (!ref) return null
  const ms = new Date(ref) - now
  return Math.ceil(ms / DAY_MS)
}

// Status values that should hard-block tenant sign-in.
function isAccessBlocked(status) {
  return status === 'expired' || status === 'past_due' || status === 'cancelled'
}

function billingSummary(org, now = new Date()) {
  const status = effectiveStatus(org, now)
  return {
    plan: org.subscriptionPlan,
    planLabel: planMeta(org.subscriptionPlan).label,
    status,
    monthlyPrice: org.monthlyPrice || planMeta(org.subscriptionPlan).monthlyPrice,
    trialEndsAt: org.trialEndsAt ? new Date(org.trialEndsAt).toISOString() : null,
    currentPeriodStart: org.currentPeriodStart ? new Date(org.currentPeriodStart).toISOString() : null,
    currentPeriodEnd: org.currentPeriodEnd ? new Date(org.currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: !!org.cancelAtPeriodEnd,
    daysUntilRenewal: daysUntilRenewal(org, now),
    blocked: isAccessBlocked(status),
  }
}

// INV-YYYY-NNNN — sequential per year. Caller passes the current count for year.
function formatInvoiceNumber(year, sequence) {
  return `INV-${year}-${String(sequence).padStart(4, '0')}`
}

module.exports = {
  PLANS,
  PLAN_LIMITS,
  LIMIT_RESOURCES,
  planMeta,
  planLimits,
  effectiveLimits,
  assertWithinLimit,
  PlanLimitError,
  periodDatesFor,
  effectiveStatus,
  daysUntilRenewal,
  isAccessBlocked,
  billingSummary,
  formatInvoiceNumber,
  addDays,
  DAY_MS,
}
