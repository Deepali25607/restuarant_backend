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
  // Every new org is seeded with 4 accounts (admin + manager + kitchen +
  // cashier), so the trial seat count leaves a little headroom above that.
  trial:      { tables: 5,    rooms: 5,    users: 6,    dishes: 30 },
  monthly:    { tables: 20,   rooms: 20,   users: 10,   dishes: 100 },
  yearly:     { tables: 30,   rooms: 30,   users: 15,   dishes: 200 },
  enterprise: { tables: null, rooms: null, users: null, dishes: null },
}

const LIMIT_RESOURCES = ['tables', 'rooms', 'users', 'dishes']

// Ordering channels and which ones each plan allows by default. Table is a
// baseline feature on every plan; Room service and Takeaway are paid-plan
// features. A tenant row may override any channel via
// Organization.<channel>OrderingAllowed (null = follow the plan default),
// letting the platform admin grant or revoke a channel per restaurant.
const ORDER_CHANNELS = ['table', 'room', 'takeaway']

function planAllowsChannel(plan, channel) {
  if (channel === 'table') return true
  // Room & Takeaway: paid plans only (anything other than trial).
  return (plan || 'trial') !== 'trial'
}

// Returns { table, room, takeaway } booleans — whether the tenant is *allowed*
// to offer each channel. Per-tenant override wins; otherwise the plan default.
function effectiveChannels(org) {
  const plan = org?.subscriptionPlan || 'trial'
  const override = {
    table: org?.tableOrderingAllowed,
    room: org?.roomOrderingAllowed,
    takeaway: org?.takeawayOrderingAllowed,
  }
  const out = {}
  for (const c of ORDER_CHANNELS) {
    out[c] = override[c] == null ? planAllowsChannel(plan, c) : Boolean(override[c])
  }
  return out
}

function planLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.trial
}

// Plans a new user may self-serve at signup, with everything the public
// pricing / comparison page needs: price, limits, allowed channels, and a
// human feature list. Enterprise is surfaced as a "contact sales" card.
const SIGNUP_PLAN_ORDER = ['trial', 'monthly', 'yearly', 'enterprise']

function unlimitedOr(n, noun) {
  return n == null ? `Unlimited ${noun}` : `${n} ${noun}`
}

function planChannels(plan) {
  const out = {}
  for (const c of ORDER_CHANNELS) out[c] = planAllowsChannel(plan, c)
  return out
}

// A display-friendly bullet list of what a plan includes.
function planFeatures(plan) {
  const lim = planLimits(plan)
  const ch = planChannels(plan)
  const channelLabels = { table: 'Dine-in (tables)', room: 'Room service', takeaway: 'Takeaway' }
  const channels = ORDER_CHANNELS.filter((c) => ch[c]).map((c) => channelLabels[c])
  return [
    unlimitedOr(lim.tables, 'tables'),
    unlimitedOr(lim.rooms, 'rooms'),
    unlimitedOr(lim.users, 'staff accounts'),
    unlimitedOr(lim.dishes, 'menu items'),
    `Ordering: ${channels.join(', ')}`,
    'Live orders, kitchen & cashier consoles',
    'Reports, loyalty & expenses',
  ]
}

function publicPlans() {
  return SIGNUP_PLAN_ORDER.map((key) => {
    const meta = planMeta(key)
    const contactSales = key === 'enterprise'
    return {
      key,
      label: meta.label,
      price: contactSales ? null : meta.monthlyPrice,
      billable: meta.billable,
      durationDays: meta.durationDays,
      // How the price reads on the card.
      priceNote:
        key === 'trial'
          ? `Free for ${meta.durationDays} days`
          : key === 'yearly'
            ? 'per month, billed yearly'
            : key === 'monthly'
              ? 'per month'
              : 'Custom pricing',
      contactSales,
      selfServe: !contactSales,
      recommended: key === 'yearly',
      limits: planLimits(key),
      channels: planChannels(key),
      features: planFeatures(key),
    }
  })
}

// Returns { tables, users, dishes } — each value is a positive Int OR null
// (unlimited). Tenant overrides win; otherwise the plan default applies.
function effectiveLimits(org) {
  const base = planLimits(org?.subscriptionPlan)
  return {
    tables: Number.isFinite(org?.maxTables) ? org.maxTables : base.tables,
    rooms: Number.isFinite(org?.maxRooms) ? org.maxRooms : base.rooms,
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
  ORDER_CHANNELS,
  planAllowsChannel,
  effectiveChannels,
  publicPlans,
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
