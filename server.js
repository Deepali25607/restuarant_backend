require('dotenv').config()
const http = require('http')
const path = require('path')
const fs = require('fs')
const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const multer = require('multer')
const { Server } = require('socket.io')
const {
  STATUS_FLOW,
  createOrder,
  getOrder,
  listOrders,
  setOrderStatus,
  setPaymentMethod,
  markPaid,
  saveRating,
  resumePendingOrders,
  prisma,
} = require('./store')
const { login, requireAuth, sign, publicUser } = require('./auth')
const {
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  defaultsForRole,
  effectivePermissions,
  sanitize: sanitizePermissions,
  requirePerm,
  orgScope,
} = require('./permissions')
const realtime = require('./realtime')
const payments = require('./payments')
const { logAudit } = require('./audit')
const loyalty = require('./loyalty')
const platformBranding = require('./platform')
const {
  loadPlans,
  planList,
  planToRow,
  planExists,
  planMeta,
  periodDatesFor,
  billingSummary,
  effectiveLimits,
  effectiveChannels,
  publicPlans,
  couponDiscount,
  couponUsable,
  assertWithinLimit,
  PlanLimitError,
  formatInvoiceNumber,
  addDays,
} = require('./billing')

// Pulls the current org row and the count of `resource` for it, then asks
// billing.assertWithinLimit to throw on overflow. Routes call this just
// before they create a new row. Callers don't need to handle the throw —
// the global error middleware below maps PlanLimitError to a 402.
function safeParseHours(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// Hydrate a raw Organization row for API responses: ISO-stringify the dates,
// parse businessHours from the JSON column, and add the derived
// subscription/limits/usage shape where useful. Keeps every endpoint that
// returns an org consistent.
function shapeOrgForApi(org, extras = {}) {
  return {
    ...org,
    createdAt: org.createdAt ? new Date(org.createdAt).toISOString() : null,
    updatedAt: org.updatedAt ? new Date(org.updatedAt).toISOString() : null,
    trialEndsAt: org.trialEndsAt ? new Date(org.trialEndsAt).toISOString() : null,
    currentPeriodStart: org.currentPeriodStart ? new Date(org.currentPeriodStart).toISOString() : null,
    currentPeriodEnd: org.currentPeriodEnd ? new Date(org.currentPeriodEnd).toISOString() : null,
    businessHours: safeParseHours(org.businessHours),
    // Effective channel entitlements (per-tenant override ?? plan default), so
    // the super-admin console can show what the tenant is currently allowed.
    allowedChannels: effectiveChannels(org),
    ...extras,
  }
}

async function enforcePlanLimit(req, resource) {
  if (req.user?.isSuper) return // super-admin acting platform-wide isn't quota'd
  if (!req.user?.orgId) return
  const [org, count] = await Promise.all([
    prisma.organization.findUnique({ where: { id: req.user.orgId } }),
    resource === 'tables'
      ? prisma.table.count({ where: { organizationId: req.user.orgId } })
      : resource === 'rooms'
        ? prisma.room.count({ where: { organizationId: req.user.orgId } })
        : resource === 'users'
          ? prisma.user.count({ where: { organizationId: req.user.orgId } })
          : prisma.dish.count({ where: { organizationId: req.user.orgId } }),
  ])
  assertWithinLimit(org, resource, count)
}

const UPLOAD_DIR = path.join(__dirname, 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safe}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only image files (png, jpg, webp, gif) are allowed'))
  },
})

const app = express()
app.use(cors({ exposedHeaders: ['x-organization-id'] }))
app.use(express.json({ limit: '2mb' }))
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }))

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'resto-backend', multitenant: true })
})

const api = express.Router()

const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

// ── Customer-org resolution ───────────────────────────────────────────
// Public endpoints (menu, tables, orders/:id, rating) read the org from the
// `x-organization-id` header. The header value can be either the org's id
// (org_*) or its slug — we normalise to the canonical id.
async function resolveCustomerOrg(req, res) {
  const raw = String(req.headers['x-organization-id'] || '').trim()
  if (!raw) {
    res.status(400).json({ message: 'Missing x-organization-id header' })
    return null
  }
  const org = await prisma.organization.findFirst({
    where: { OR: [{ id: raw }, { slug: raw }], active: true },
  })
  if (!org) {
    res.status(404).json({ message: 'Organization not found or inactive' })
    return null
  }
  return org
}

// ── Auth ──────────────────────────────────────────────────────────────
api.post('/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {}
  const result = await login(email, password)
  if (!result) return res.status(401).json({ message: 'Invalid email or password' })
  if (result.error) return res.status(403).json({ message: result.error })

  req.user = {
    sub: result.user.id,
    name: result.user.name,
    role: result.user.role,
    orgId: result.user.organizationId,
  }
  logAudit(req, {
    action: 'login',
    entity: 'auth',
    entityId: result.user.id,
    summary: `${result.user.name} signed in`,
  })
  res.json(result)
}))

api.get('/auth/me', requirePerm(), asyncRoute(async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.user.sub } })
  if (!u) return res.status(404).json({ message: 'Account not found' })
  const organization = u.organizationId
    ? await prisma.organization.findUnique({ where: { id: u.organizationId } })
    : null
  res.json(publicUser(u, organization))
}))

// Self-service password change — any signed-in user, gated by re-entering
// their current password. requirePerm() (no args) just means "authenticated".
api.post('/auth/change-password', requirePerm(), asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'Current and new password are required' })
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' })
  }
  const u = await prisma.user.findUnique({ where: { id: req.user.sub } })
  if (!u) return res.status(404).json({ message: 'Account not found' })
  const ok = await bcrypt.compare(String(currentPassword), u.passwordHash)
  if (!ok) {
    return res.status(400).json({ message: 'Current password is incorrect', code: 'bad_current_password' })
  }
  if (await bcrypt.compare(String(newPassword), u.passwordHash)) {
    return res.status(400).json({ message: 'New password must be different from the current one' })
  }
  await prisma.user.update({
    where: { id: u.id },
    data: { passwordHash: bcrypt.hashSync(String(newPassword), 10) },
  })
  logAudit(req, {
    action: 'password_change',
    entity: 'user',
    entityId: u.id,
    summary: `${u.name} changed their password`,
  })
  res.json({ ok: true })
}))

// ── Org provisioning + public self-service signup ─────────────────────
// Starter menu categories so a brand-new org's admin can add dishes right
// away (a dish needs a categoryId that belongs to its org).
const SIGNUP_SEED_CATEGORIES = [
  { id: 'starters', name: 'Starters', emoji: '🍢', order: 1 },
  { id: 'mains', name: 'Main Course', emoji: '🍛', order: 2 },
  { id: 'breads', name: 'Breads & Rice', emoji: '🫓', order: 3 },
  { id: 'desserts', name: 'Desserts', emoji: '🍮', order: 4 },
  { id: 'beverages', name: 'Beverages', emoji: '🥤', order: 5 },
]

// Default staff accounts provisioned with every new org. They start with their
// role's baseline permissions (permissions = null) and a random placeholder
// password — the admin sets real details from Staff Management before handing
// them out. Roles map to the existing role-permission presets.
const DEFAULT_STAFF = [
  { role: 'manager', name: 'Manager' },
  { role: 'kitchen', name: 'Kitchen Staff' },
  { role: 'cashier', name: 'Cashier' },
]

const randomSecret = () =>
  Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)

function slugifyName(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Derive a URL-safe slug from the org name, appending -2, -3… until unique.
async function uniqueOrgSlug(base) {
  const root = slugifyName(base) || 'restaurant'
  let candidate = root
  let n = 1
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    candidate = `${root}-${++n}`
  }
  return candidate
}

const httpError = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, expose: true, ...extra })

// Creates an organization + its first admin user + starter categories in one
// transaction. Throws an HTTP-shaped error on validation failure. Shared by the
// super-admin console and the public signup flow. `active=false` provisions a
// pending org (used for paid plans awaiting payment).
async function createOrgWithAdmin({ name, slug, admin, plan, monthlyPrice, active = true, orgExtra = {} }) {
  if (!name) throw httpError(400, 'Organization name is required')
  const finalSlug = String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (!finalSlug) throw httpError(400, 'A valid slug is required')
  if (await prisma.organization.findUnique({ where: { slug: finalSlug } })) {
    throw httpError(409, 'That web address is already taken — try a different name.')
  }
  const adminName = String(admin?.name || '').trim()
  const adminEmail = String(admin?.email || '').trim().toLowerCase()
  const adminPassword = String(admin?.password || '')
  if (!adminName || !adminEmail || !adminPassword) {
    throw httpError(400, 'First admin requires a name, email, and password.', { field: 'admin' })
  }
  if (adminPassword.length < 6) throw httpError(400, 'Admin password must be at least 6 characters.')
  if (await prisma.user.findUnique({ where: { email: adminEmail } })) {
    throw httpError(409, `Email "${adminEmail}" is already used by another account.`)
  }

  const safePlan = planExists(plan) ? plan : 'trial'
  const meta = planMeta(safePlan)
  const dates = periodDatesFor(safePlan)
  const orgId = `org_${finalSlug}_${Math.random().toString(36).slice(2, 6)}`

  const [org, adminUser] = await prisma.$transaction([
    prisma.organization.create({
      data: {
        id: orgId,
        name: String(name),
        slug: finalSlug,
        logoUrl: String(orgExtra.logoUrl || ''),
        themeColor: String(orgExtra.themeColor || '#ea580c'),
        address: String(orgExtra.address || ''),
        gstNumber: String(orgExtra.gstNumber || ''),
        contactPhone: String(orgExtra.contactPhone || ''),
        contactEmail: String(orgExtra.contactEmail || adminEmail),
        subscriptionPlan: safePlan,
        subscriptionStatus: !active ? 'incomplete' : planMeta(safePlan).isTrial ? 'trial' : 'active',
        monthlyPrice: Number.isFinite(monthlyPrice) ? monthlyPrice : meta.monthlyPrice,
        timezone: orgExtra.timezone ? String(orgExtra.timezone) : undefined,
        locale: orgExtra.locale ? String(orgExtra.locale) : undefined,
        currency: orgExtra.currency ? String(orgExtra.currency) : undefined,
        currencySymbol: orgExtra.currencySymbol ? String(orgExtra.currencySymbol) : undefined,
        gstRate: Number.isFinite(orgExtra.gstRate) ? orgExtra.gstRate : undefined,
        taxLabel: orgExtra.taxLabel ? String(orgExtra.taxLabel) : undefined,
        businessHours: orgExtra.businessHours ? JSON.stringify(orgExtra.businessHours) : undefined,
        ...dates,
        active,
      },
    }),
    prisma.user.create({
      data: {
        id: `u_admin_${orgId}_${Math.random().toString(36).slice(2, 5)}`,
        organizationId: orgId,
        name: adminName,
        email: adminEmail,
        role: 'admin',
        passwordHash: bcrypt.hashSync(adminPassword, 10),
      },
    }),
    // Default staff roles — Manager, Kitchen, Cashier — managed afterwards from
    // the Staff Management module (edit details, reset password, permissions,
    // activate/deactivate). Emails derive from the unique orgId so they never
    // clash; the admin can change them to real addresses later.
    ...DEFAULT_STAFF.map((s) =>
      prisma.user.create({
        data: {
          id: `u_${s.role}_${orgId}_${Math.random().toString(36).slice(2, 5)}`,
          organizationId: orgId,
          name: s.name,
          email: `${s.role}@${orgId.replace(/_/g, '-')}.com`,
          role: s.role,
          passwordHash: bcrypt.hashSync(randomSecret(), 10),
        },
      }),
    ),
    ...SIGNUP_SEED_CATEGORIES.map((c) =>
      prisma.category.create({
        data: { id: `${orgId}_${c.id}`, organizationId: orgId, name: c.name, emoji: c.emoji, order: c.order },
      }),
    ),
  ])
  return { org, adminUser }
}

// Records a paid subscription invoice for an org (used after a successful
// signup payment, and by the manual fallback when Razorpay isn't configured).
async function recordPaidInvoice(org, { paymentMethod, notes, amount }) {
  const year = new Date().getFullYear()
  const seq = (await prisma.invoice.count({ where: { number: { startsWith: `INV-${year}-` } } })) + 1
  const periodStart = org.currentPeriodStart ? new Date(org.currentPeriodStart) : new Date()
  const periodEnd = org.currentPeriodEnd
    ? new Date(org.currentPeriodEnd)
    : addDays(periodStart, planMeta(org.subscriptionPlan).durationDays || 30)
  return prisma.invoice.create({
    data: {
      id: `inv_${Math.random().toString(36).slice(2, 10)}`,
      organizationId: org.id,
      number: formatInvoiceNumber(year, seq),
      plan: org.subscriptionPlan,
      amount: Number.isFinite(amount) ? amount : (org.monthlyPrice || planMeta(org.subscriptionPlan).monthlyPrice),
      currency: 'INR',
      status: 'paid',
      periodStart,
      periodEnd,
      dueAt: periodStart,
      paidAt: new Date(),
      paymentMethod: String(paymentMethod || ''),
      notes: String(notes || 'Self-service signup'),
    },
  })
}

// Resolve a signup coupon against a plan: returns the coupon row, the discount
// it grants on the plan price, and the resulting charge. Returns a reason when
// the code is present but unusable.
async function resolveSignupCoupon(code, planId) {
  const trimmed = String(code || '').trim()
  const base = planMeta(planId).monthlyPrice
  if (!trimmed) return { coupon: null, discount: 0, finalAmount: base }
  const coupon = await prisma.coupon.findUnique({ where: { code: trimmed.toUpperCase() } })
  const check = couponUsable(coupon, planId)
  if (!coupon || !check.ok) {
    return { coupon: null, discount: 0, finalAmount: base, error: check.reason || 'Invalid coupon code.' }
  }
  const discount = couponDiscount(coupon, base)
  return { coupon, discount, finalAmount: Math.max(0, base - discount) }
}

// Build the auth session (token + public user) returned on a successful signup
// so the new admin lands straight in their dashboard.
function sessionFor(user, organization) {
  return { token: sign(user), user: publicUser(user, organization) }
}

// Public: the plans a visitor can compare & subscribe to.
api.get('/public/plans', (req, res) => {
  res.json({ plans: publicPlans(), payment: payments.status() })
})

// Public: check a coupon against a plan and preview the discount, so the signup
// page can show the new price before the customer commits.
api.post('/public/coupons/validate', asyncRoute(async (req, res) => {
  const code = String(req.body?.code || '').trim()
  const plan = String(req.body?.plan || '')
  if (!code) return res.status(400).json({ valid: false, message: 'Enter a coupon code.' })
  if (!planExists(plan) || !planMeta(plan).billable) {
    return res.status(400).json({ valid: false, message: 'Coupons apply to paid plans only.' })
  }
  const { coupon, discount, finalAmount, error } = await resolveSignupCoupon(code, plan)
  if (!coupon) return res.json({ valid: false, message: error || 'Invalid coupon code.' })
  res.json({
    valid: true,
    code: coupon.code,
    discountType: coupon.discountType,
    discountValue: coupon.discountValue,
    discount,
    originalAmount: planMeta(plan).monthlyPrice,
    finalAmount,
    description: coupon.description,
  })
}))

// Public: create an organization from the signup form. Trial activates
// immediately; paid plans return a Razorpay order to complete payment (or, when
// Razorpay isn't configured, fall back to activating right away).
api.post('/public/signup', asyncRoute(async (req, res) => {
  const b = req.body || {}
  const requestedPlan = String(b.plan || 'trial')
  const plan = planExists(requestedPlan) ? requestedPlan : 'trial'
  // Contact-sales plans (e.g. Enterprise) aren't self-serve.
  if (planMeta(plan).contactSales || planMeta(plan).selfServe === false) {
    return res.status(400).json({ message: 'This plan is set up by our team — please contact sales.' })
  }
  const orgName = String(b.org?.name || b.orgName || '').trim()
  if (!orgName) return res.status(400).json({ message: 'Please enter your restaurant name.' })

  const isPaid = planMeta(plan).billable
  // Apply a coupon (paid plans only — trial is already free).
  const couponCode = isPaid ? b.coupon : ''
  const { coupon, discount, finalAmount, error: couponError } = await resolveSignupCoupon(couponCode, plan)
  if (couponCode && couponError) return res.status(400).json({ message: couponError, field: 'coupon' })
  const chargeNote = coupon ? ` · coupon ${coupon.code} (−₹${discount})` : ''
  const slug = await uniqueOrgSlug(orgName)

  try {
    // Paid plan with Razorpay live → provision pending, collect payment first.
    // A 100%-off coupon makes the charge zero → skip Razorpay, activate now.
    if (isPaid && payments.configured && finalAmount > 0) {
      const { org } = await createOrgWithAdmin({
        name: orgName,
        slug,
        admin: b.admin,
        plan,
        active: false,
        orgExtra: { contactPhone: b.admin?.phone },
      })
      const rzpOrder = await payments.createOrder({
        amount: finalAmount,
        receipt: org.id,
        notes: { kind: 'subscription', orgId: org.id, plan, coupon: coupon?.code || '' },
      })
      return res.status(201).json({
        requiresPayment: true,
        orgId: org.id,
        plan,
        amount: finalAmount,
        coupon: coupon ? { code: coupon.code, discount } : null,
        rzpOrder,
        keyId: payments.status().keyId,
      })
    }

    // Trial → free & instant. Paid-without-Razorpay (or fully discounted) →
    // activate now and record the invoice so the org is usable immediately.
    const { org, adminUser } = await createOrgWithAdmin({
      name: orgName,
      slug,
      admin: b.admin,
      plan,
      active: true,
      orgExtra: { contactPhone: b.admin?.phone },
    })
    if (isPaid) {
      await recordPaidInvoice(org, {
        paymentMethod: payments.configured ? 'coupon' : 'manual',
        notes: `Signup${payments.configured ? '' : ' (manual fallback)'}${chargeNote}`,
        amount: finalAmount,
      })
      if (coupon) await prisma.coupon.update({ where: { id: coupon.id }, data: { redemptions: { increment: 1 } } })
    }
    return res.status(201).json({
      requiresPayment: false,
      fallback: isPaid && !payments.configured,
      organizationId: org.id,
      coupon: coupon ? { code: coupon.code, discount } : null,
      ...sessionFor(adminUser, org),
    })
  } catch (e) {
    if (e.status && e.expose) return res.status(e.status).json({ message: e.message, field: e.field })
    throw e
  }
}))

// Public: confirm a Razorpay subscription payment, then activate the org and
// sign the new admin in.
api.post('/public/signup/verify', asyncRoute(async (req, res) => {
  const { orgId, razorpay_order_id, razorpay_payment_id, razorpay_signature, coupon: couponCode } = req.body || {}
  if (!orgId) return res.status(400).json({ message: 'orgId is required' })
  const ok = payments.verifySignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  })
  if (!ok) return res.status(400).json({ message: 'Payment could not be verified. Please contact support.' })

  const org = await prisma.organization.findUnique({ where: { id: orgId } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })

  // Activate (idempotent — re-verifying an already-active org is harmless).
  const activated = org.active
    ? org
    : await prisma.organization.update({
        where: { id: org.id },
        data: { active: true, subscriptionStatus: 'active' },
      })
  if (!org.active) {
    // Re-resolve the coupon so the invoice records the amount actually charged
    // and the redemption is counted once payment has succeeded.
    const { coupon, discount, finalAmount } = await resolveSignupCoupon(couponCode, activated.subscriptionPlan)
    await recordPaidInvoice(activated, {
      paymentMethod: 'razorpay',
      notes: `Signup · ${razorpay_payment_id}${coupon ? ` · coupon ${coupon.code} (−₹${discount})` : ''}`,
      amount: finalAmount,
    })
    if (coupon) await prisma.coupon.update({ where: { id: coupon.id }, data: { redemptions: { increment: 1 } } })
  }

  const adminUser = await prisma.user.findFirst({
    where: { organizationId: org.id, role: 'admin' },
    orderBy: { createdAt: 'asc' },
  })
  if (!adminUser) return res.status(500).json({ message: 'Admin account missing for this organization.' })
  res.json({ organizationId: org.id, ...sessionFor(adminUser, activated) })
}))

// Tenant-facing usage gauge. Returns the per-resource used/limit pair so the
// admin UI can show "12 / 20 tables" and surface a warning when the cap is
// close. Super-admins targeting an org via x-target-org see that org's usage.
api.get('/usage', requirePerm(), asyncRoute(async (req, res) => {
  const orgId = req.user?.orgId
  if (!orgId) return res.json({ resources: {}, plan: null, limits: {}, isUnlimited: true })
  const [org, tables, users, dishes] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId } }),
    prisma.table.count({ where: { organizationId: orgId } }),
    prisma.user.count({ where: { organizationId: orgId } }),
    prisma.dish.count({ where: { organizationId: orgId } }),
  ])
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  const limits = effectiveLimits(org)
  const pack = (used, limit) => ({
    used,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - used),
    isUnlimited: limit == null,
    isAtLimit: limit != null && used >= limit,
    isNearLimit: limit != null && used >= Math.max(1, Math.floor(limit * 0.8)),
    pct: limit == null ? 0 : Math.min(100, Math.round((used / limit) * 100)),
  })
  res.json({
    plan: org.subscriptionPlan,
    planLabel: planMeta(org.subscriptionPlan).label,
    limits,
    resources: {
      tables: pack(tables, limits.tables),
      users: pack(users, limits.users),
      dishes: pack(dishes, limits.dishes),
    },
  })
}))

// ── Platform branding (the SaaS itself) ───────────────────────────────
// Public — no auth, so the customer landing + admin login can show the
// platform name/logo/colour before anyone signs in.
api.get('/platform/branding', asyncRoute(async (req, res) => {
  res.json(await platformBranding.getPlatformBranding())
}))

api.patch('/platform/branding', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const next = await platformBranding.updatePlatformBranding(req.body || {})
  logAudit(req, {
    action: 'update',
    entity: 'platform',
    entityId: 'branding',
    summary: `Platform branding updated → "${next.name}"`,
    metadata: { fields: Object.keys(req.body || {}) },
  })
  res.json(next)
}))

// ── Public org branding ───────────────────────────────────────────────
// Customer-facing — returns enough to skin the menu before login.
api.get('/organizations/:slugOrId/branding', asyncRoute(async (req, res) => {
  const key = req.params.slugOrId
  const org = await prisma.organization.findFirst({
    where: { OR: [{ id: key }, { slug: key }] },
  })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  if (!org.active) return res.status(403).json({ message: 'Organization is inactive' })
  // Customers see a channel only when the plan allows it AND the restaurant
  // has turned it on. A plan-restricted channel is never advertised.
  const allowed = effectiveChannels(org)
  res.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    logoUrl: org.logoUrl,
    paymentQrUrl: org.paymentQrUrl,
    themeColor: org.themeColor,
    address: org.address,
    gstNumber: org.gstNumber,
    contactPhone: org.contactPhone,
    contactEmail: org.contactEmail,
    timezone: org.timezone,
    locale: org.locale,
    currency: org.currency,
    currencySymbol: org.currencySymbol,
    gstRate: org.gstRate,
    taxLabel: org.taxLabel,
    businessHours: safeParseHours(org.businessHours),
    tableOrderingEnabled: allowed.table && org.tableOrderingEnabled,
    roomOrderingEnabled: allowed.room && org.roomOrderingEnabled,
    takeawayOrderingEnabled: allowed.takeaway && org.takeawayOrderingEnabled,
  })
}))

// ── Public catalog (org-scoped via header) ────────────────────────────
api.get('/categories', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const cats = await prisma.category.findMany({
    where: { organizationId: org.id },
    orderBy: { order: 'asc' },
  })
  res.json(cats)
}))

api.get('/menu', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const dishes = await prisma.dish.findMany({
    where: { organizationId: org.id },
  })
  res.json(dishes.map((d) => ({ ...d, tag: d.tag || undefined })))
}))

api.get('/tables/:no', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const table = await prisma.table.findUnique({
    where: { organizationId_number: { organizationId: org.id, number: req.params.no } },
  })
  if (!table) return res.status(404).json({ message: 'Table not found' })

  // Occupancy from the customer's perspective: a table is "held" when it has
  // any unpaid orders. If those orders came from a different sessionId than
  // the one supplied, the table is considered locked for this customer.
  const sessionId = String(req.query.sessionId || '').trim() || null
  const heldOrders = await prisma.order.findMany({
    where: { organizationId: org.id, tableNo: req.params.no, serviceType: 'table', paymentStatus: { not: 'paid' } },
    select: { id: true, sessionId: true, status: true, createdAt: true },
  })
  let occupiedBy = null
  if (heldOrders.length) {
    const mine = sessionId && heldOrders.some((o) => o.sessionId === sessionId)
    occupiedBy = mine ? 'self' : 'other'
  }
  res.json({
    ...table,
    status: occupiedBy ? 'occupied' : 'available',
    occupiedBy,
    activeOrderCount: heldOrders.length,
  })
}))

// ── Room-service: customer-facing parallels of the table endpoints ──────
api.get('/rooms/:no', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const room = await prisma.room.findUnique({
    where: { organizationId_number: { organizationId: org.id, number: req.params.no } },
  })
  if (!room) return res.status(404).json({ message: 'Room not found' })
  const sessionId = String(req.query.sessionId || '').trim() || null
  const heldOrders = await prisma.order.findMany({
    where: { organizationId: org.id, tableNo: req.params.no, serviceType: 'room', paymentStatus: { not: 'paid' } },
    select: { id: true, sessionId: true },
  })
  let occupiedBy = null
  if (heldOrders.length) {
    const mine = sessionId && heldOrders.some((o) => o.sessionId === sessionId)
    occupiedBy = mine ? 'self' : 'other'
  }
  res.json({
    ...room,
    status: occupiedBy ? 'occupied' : 'available',
    occupiedBy,
    activeOrderCount: heldOrders.length,
  })
}))

api.get('/rooms/:no/tab', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const tableNo = String(req.params.no)
  const rows = await prisma.order.findMany({
    where: { organizationId: org.id, tableNo, serviceType: 'room', paymentStatus: { not: 'paid' } },
    include: { items: true, rating: true },
    orderBy: { createdAt: 'asc' },
  })
  const { toApiOrder } = require('./db')
  const orders = rows.map(toApiOrder)
  const totals = orders.reduce(
    (acc, o) => {
      acc.subtotal += o.amounts?.subtotal || 0
      acc.tax += o.amounts?.tax || 0
      acc.tip += o.amounts?.tip || 0
      acc.discount += o.amounts?.discount || 0
      acc.total += o.amounts?.total || 0
      acc.items += (o.items || []).reduce((s, it) => s + (it.qty || 0), 0)
      return acc
    },
    { subtotal: 0, tax: 0, tip: 0, discount: 0, total: 0, items: 0 },
  )
  res.json({
    tableNo,
    serviceType: 'room',
    orderCount: orders.length,
    totals,
    orders: orders.map((o) => ({
      id: o.id,
      status: o.status,
      createdAt: o.createdAt,
      paymentStatus: o.paymentStatus,
      etaMinutes: o.etaMinutes,
      queuePosition: o.queuePosition,
      amounts: o.amounts,
      itemCount: (o.items || []).reduce((s, it) => s + (it.qty || 0), 0),
      items: (o.items || []).map((it) => ({ name: it.name, qty: it.qty, price: it.price })),
    })),
  })
}))

api.get('/tables/:no/tab', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const tableNo = String(req.params.no)
  const rows = await prisma.order.findMany({
    where: { organizationId: org.id, tableNo, serviceType: 'table', paymentStatus: { not: 'paid' } },
    include: { items: true, rating: true },
    orderBy: { createdAt: 'asc' },
  })
  const { toApiOrder } = require('./db')
  const orders = rows.map(toApiOrder)
  const totals = orders.reduce(
    (acc, o) => {
      acc.subtotal += o.amounts?.subtotal || 0
      acc.tax += o.amounts?.tax || 0
      acc.tip += o.amounts?.tip || 0
      acc.discount += o.amounts?.discount || 0
      acc.total += o.amounts?.total || 0
      acc.items += (o.items || []).reduce((s, it) => s + (it.qty || 0), 0)
      return acc
    },
    { subtotal: 0, tax: 0, tip: 0, discount: 0, total: 0, items: 0 },
  )
  res.json({
    tableNo,
    orderCount: orders.length,
    totals,
    orders: orders.map((o) => ({
      id: o.id,
      status: o.status,
      createdAt: o.createdAt,
      paymentStatus: o.paymentStatus,
      etaMinutes: o.etaMinutes,
      queuePosition: o.queuePosition,
      amounts: o.amounts,
      itemCount: (o.items || []).reduce((s, it) => s + (it.qty || 0), 0),
      items: (o.items || []).map((it) => ({ name: it.name, qty: it.qty, price: it.price })),
    })),
  })
}))

// ── Orders (customer) ─────────────────────────────────────────────────
api.post('/orders', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const { tableNo, sessionId, items, payment, amounts, loyalty: loyaltyInput } = req.body || {}
  const serviceType = ['room', 'takeaway'].includes(req.body?.serviceType)
    ? req.body.serviceType
    : 'table'
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'items are required' })
  }
  // Takeaway has no physical location; table/room require a number.
  if (serviceType !== 'takeaway' && !tableNo) {
    return res.status(400).json({ message: 'tableNo is required' })
  }

  // Channel gate: refuse orders for a service type that the plan doesn't allow
  // or the tenant has switched off. Effective availability = allowed && enabled.
  const allowedChannels = effectiveChannels(org)
  const channelEnabled = {
    table: org.tableOrderingEnabled,
    room: org.roomOrderingEnabled,
    takeaway: org.takeawayOrderingEnabled,
  }
  if (!(allowedChannels[serviceType] && channelEnabled[serviceType])) {
    const niceName = serviceType === 'room' ? 'Room service' : serviceType === 'takeaway' ? 'Takeaway' : 'Table ordering'
    return res.status(403).json({ code: 'channel_disabled', message: `${niceName} is not available here.` })
  }

  const label = serviceType === 'room' ? 'Room' : 'Table'

  // Busy guard: refuse to take an order on a table/room that another customer
  // (different sessionId) has an open tab on. Same-session adds are allowed.
  // Takeaway orders are independent (no shared location) so they skip this.
  if (serviceType !== 'takeaway') {
    const heldByOther = await prisma.order.findFirst({
      where: {
        organizationId: org.id,
        tableNo: String(tableNo),
        serviceType,
        paymentStatus: { not: 'paid' },
        ...(sessionId ? { sessionId: { not: sessionId } } : {}),
      },
    })
    if (heldByOther) {
      return res.status(409).json({
        code: 'table_occupied',
        message: `${label} ${tableNo} is currently occupied by another customer. Please pick a different ${label.toLowerCase()}.`,
      })
    }
  }

  try {
    const order = await createOrder({
      organizationId: org.id,
      tableNo,
      serviceType,
      sessionId,
      items,
      payment,
      amounts,
      loyalty: loyaltyInput,
    })
    res.status(201).json(order)
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ message: e.message })
    throw e
  }
}))

api.get('/loyalty/lookup', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const member = await loyalty.findMember(req.query.phone, org.id)
  if (!member) return res.json({ exists: false })
  res.json({
    exists: true,
    phone: member.phone,
    name: member.name,
    points: member.points,
    visits: member.visits,
  })
}))

api.post('/loyalty/join', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const { phone, name } = req.body || {}
  const member = await loyalty.upsertMember({ phone, name, organizationId: org.id })
  if (!member) return res.status(400).json({ message: 'Valid phone required' })
  res.json({
    phone: member.phone,
    name: member.name,
    points: member.points,
    visits: member.visits,
  })
}))

api.get('/orders/:id', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const order = await getOrder(req.params.id, { organizationId: org.id })
  if (!order) return res.status(404).json({ message: 'Order not found' })
  res.json(order)
}))

// Customer picks how they'll pay from the post-order popup (scan QR vs cash at
// counter). Public + org-scoped; records intent only — the cashier still
// confirms the actual payment from the billing desk.
api.patch('/orders/:id/payment-method', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const { method } = req.body || {}
  try {
    const order = await setPaymentMethod(req.params.id, method, { organizationId: org.id })
    if (!order) return res.status(404).json({ message: 'Order not found' })
    res.json(order)
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ message: e.message })
    throw e
  }
}))

api.post('/orders/:id/rating', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const { food, service, overall, comments } = req.body || {}
  if (!overall) return res.status(400).json({ message: 'Overall rating is required' })
  const order = await saveRating(req.params.id, {
    food, service, overall, comments, organizationId: org.id,
  })
  if (!order) return res.status(404).json({ message: 'Order not found' })
  res.json(order)
}))

// ── Admin: dashboards & orders ────────────────────────────────────────
api.get('/admin/overview', requirePerm('dashboard.view'), asyncRoute(async (req, res) => {
  const orders = await listOrders({ organizationId: req.user.orgId })
  const completed = orders.filter((o) => o.status === 'served')
  const revenue = completed.reduce((s, o) => s + (o.amounts?.total || 0), 0)
  const dishCounts = new Map()
  completed.forEach((o) =>
    o.items.forEach((it) => {
      dishCounts.set(it.name, (dishCounts.get(it.name) || 0) + it.qty)
    }),
  )
  const popular = [...dishCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }))
  const tableCount = await prisma.table.count({ where: orgScope(req) })
  res.json({
    totals: {
      revenue,
      orders: orders.length,
      activeOrders: orders.filter((o) => o.status !== 'served').length,
      tables: tableCount,
    },
    popular,
    recent: orders.slice(0, 8).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber ?? null,
      tableNo: o.tableNo,
      status: o.status,
      total: o.amounts?.total,
      createdAt: o.createdAt,
    })),
  })
}))

api.get('/admin/orders', requirePerm('orders.view'), asyncRoute(async (req, res) => {
  res.json(await listOrders({ status: req.query.status, organizationId: req.user.orgId }))
}))

api.patch('/admin/orders/:id/status', requirePerm('orders.update'), asyncRoute(async (req, res) => {
  const { status } = req.body || {}
  if (!STATUS_FLOW.includes(status)) {
    return res.status(400).json({ message: 'Invalid status' })
  }
  let updated
  try {
    updated = await setOrderStatus(req.params.id, status, { organizationId: req.user.orgId })
  } catch (e) {
    if (e.code === 'payment_required') {
      return res.status(409).json({ message: e.message, code: e.code })
    }
    throw e
  }
  if (!updated) return res.status(404).json({ message: 'Order not found' })
  logAudit(req, {
    action: 'status_change',
    entity: 'order',
    entityId: updated.id,
    summary: `Order #${updated.orderNumber ?? updated.id.slice(-6).toUpperCase()} → ${status} (T${updated.tableNo})`,
    metadata: { status, tableNo: updated.tableNo },
  })
  res.json(updated)
}))

// ── Admin: restaurant settings (self-service) ─────────────────────────
// The tenant admin/manager edits their own org's customer-facing details —
// notably the payment QR image shown in the post-order checkout popup. Always
// scoped to the caller's own org; super-admins keep the broader
// /super-admin/organizations endpoints for cross-tenant edits.
const ORG_SETTINGS_FIELDS = [
  'name', 'logoUrl', 'paymentQrUrl', 'themeColor',
  'address', 'gstNumber', 'contactPhone', 'contactEmail',
]

const ORG_SETTINGS_BOOL_FIELDS = ['tableOrderingEnabled', 'roomOrderingEnabled', 'takeawayOrderingEnabled']

function orgSettingsView(org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logoUrl: org.logoUrl,
    paymentQrUrl: org.paymentQrUrl,
    themeColor: org.themeColor,
    address: org.address,
    gstNumber: org.gstNumber,
    contactPhone: org.contactPhone,
    contactEmail: org.contactEmail,
    tableOrderingEnabled: org.tableOrderingEnabled,
    roomOrderingEnabled: org.roomOrderingEnabled,
    takeawayOrderingEnabled: org.takeawayOrderingEnabled,
    // Which channels the plan/platform allows. The tenant's settings UI hides
    // toggles for channels that aren't allowed, and the PATCH below refuses to
    // enable one. The platform admin controls this from the super-admin console.
    allowedChannels: effectiveChannels(org),
  }
}

api.get('/admin/organization', requirePerm('settings.manage'), asyncRoute(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.user.orgId } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  res.json(orgSettingsView(org))
}))

api.patch('/admin/organization', requirePerm('settings.manage'), asyncRoute(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.user.orgId } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  const b = req.body || {}
  const data = {}
  for (const key of ORG_SETTINGS_FIELDS) {
    if (key in b) data[key] = String(b[key] ?? '')
  }
  // The tenant can only toggle channels their plan allows; trying to enable a
  // restricted one is refused (the UI hides it, this is the server-side guard).
  const allowed = effectiveChannels(org)
  for (const key of ORG_SETTINGS_BOOL_FIELDS) {
    if (!(key in b)) continue
    const channel = key.replace('OrderingEnabled', '') // table | room | takeaway
    if (b[key] && !allowed[channel]) {
      return res.status(403).json({
        code: 'channel_not_allowed',
        message: `${channel.charAt(0).toUpperCase() + channel.slice(1)} ordering isn't included in your plan.`,
      })
    }
    data[key] = Boolean(b[key])
  }
  if (!Object.keys(data).length) {
    return res.status(400).json({ message: 'No editable fields supplied' })
  }
  const updated = await prisma.organization.update({ where: { id: org.id }, data })
  logAudit(req, {
    action: 'update',
    entity: 'organization',
    entityId: updated.id,
    summary: 'Restaurant settings updated',
    metadata: { fields: Object.keys(data) },
  })
  res.json(orgSettingsView(updated))
}))

// ── Admin: Menu CRUD ──────────────────────────────────────────────────
// ── Menu categories ───────────────────────────────────────────────────
api.get('/admin/categories', requirePerm('menu.manage'), asyncRoute(async (req, res) => {
  const cats = await prisma.category.findMany({
    where: orgScope(req),
    orderBy: { order: 'asc' },
  })
  res.json(cats)
}))

api.post('/admin/categories', requirePerm('menu.manage'), asyncRoute(async (req, res) => {
  const b = req.body || {}
  const name = String(b.name || '').trim()
  if (!name) return res.status(400).json({ message: 'name is required' })

  // Default ordering: append to the end of the org's existing categories.
  const last = await prisma.category.findFirst({
    where: { organizationId: req.user.orgId },
    orderBy: { order: 'desc' },
    select: { order: true },
  })
  const order = Number.isFinite(b.order) ? Number(b.order) : (last?.order || 0) + 1

  const created = await prisma.category.create({
    data: {
      id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      organizationId: req.user.orgId,
      name,
      emoji: String(b.emoji || '🍽️').trim() || '🍽️',
      order,
    },
  })
  logAudit(req, {
    action: 'create',
    entity: 'category',
    entityId: created.id,
    summary: `Added category "${created.name}"`,
    metadata: { name: created.name, emoji: created.emoji },
  })
  res.status(201).json(created)
}))

api.patch('/admin/categories/:id', requirePerm('menu.manage'), asyncRoute(async (req, res) => {
  const target = await prisma.category.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Category not found' })
  const b = req.body || {}
  const data = {}
  if ('name' in b) {
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ message: 'name cannot be empty' })
    data.name = name
  }
  if ('emoji' in b) data.emoji = String(b.emoji || '🍽️').trim() || '🍽️'
  if ('order' in b && Number.isFinite(b.order)) data.order = Number(b.order)
  const updated = await prisma.category.update({ where: { id: target.id }, data })
  logAudit(req, {
    action: 'update',
    entity: 'category',
    entityId: updated.id,
    summary: `Edited category "${updated.name}"`,
    metadata: { name: updated.name, emoji: updated.emoji },
  })
  res.json(updated)
}))

api.delete('/admin/categories/:id', requirePerm('menu.manage'), asyncRoute(async (req, res) => {
  const target = await prisma.category.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Category not found' })
  // Refuse to delete a category that still has dishes — orphaned dishes would
  // break the menu (a dish's categoryId must point to a real category).
  const dishCount = await prisma.dish.count({
    where: { categoryId: target.id, ...orgScope(req) },
  })
  if (dishCount > 0) {
    return res.status(409).json({
      message: `Move or delete the ${dishCount} dish(es) in "${target.name}" first.`,
    })
  }
  const removed = await prisma.category.delete({ where: { id: target.id } })
  logAudit(req, {
    action: 'delete',
    entity: 'category',
    entityId: removed.id,
    summary: `Deleted category "${removed.name}"`,
    metadata: { name: removed.name },
  })
  res.json(removed)
}))

api.post('/admin/menu', requirePerm('menu.manage'), asyncRoute(async (req, res) => {
  const d = req.body || {}
  if (!d.name || !d.categoryId || !d.price) {
    return res.status(400).json({ message: 'name, categoryId, price required' })
  }
  // Category must belong to the caller's org.
  const cat = await prisma.category.findFirst({
    where: { id: String(d.categoryId), organizationId: req.user.orgId },
  })
  if (!cat) return res.status(400).json({ message: 'Category not found in this organization' })

  await enforcePlanLimit(req, 'dishes')

  const created = await prisma.dish.create({
    data: {
      id: `d_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      organizationId: req.user.orgId,
      name: String(d.name),
      description: String(d.description || ''),
      categoryId: String(d.categoryId),
      price: Number(d.price),
      image: String(d.image || ''),
      isVeg: Boolean(d.isVeg),
      spice: Math.min(3, Math.max(0, Number(d.spice) || 0)),
      available: d.available !== false,
      tag: d.tag || null,
      trackStock: Boolean(d.trackStock),
      stock: Math.max(0, Number(d.stock) || 0),
      lowStockAt: Math.max(0, Number(d.lowStockAt) || 5),
      prepMinutes: Math.max(0, Math.min(120, Number(d.prepMinutes) || 0)),
    },
  })
  logAudit(req, {
    action: 'create',
    entity: 'dish',
    entityId: created.id,
    summary: `Added "${created.name}" (₹${created.price})`,
    metadata: { name: created.name, price: created.price, categoryId: created.categoryId },
  })
  res.status(201).json({ ...created, tag: created.tag || undefined })
}))

api.patch('/admin/menu/:id', requirePerm('menu.manage'), asyncRoute(async (req, res) => {
  const before = await prisma.dish.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!before) return res.status(404).json({ message: 'Dish not found' })
  const data = {}
  const b = req.body || {}
  if ('name' in b) data.name = String(b.name)
  if ('description' in b) data.description = String(b.description)
  if ('categoryId' in b) data.categoryId = String(b.categoryId)
  if ('price' in b) data.price = Number(b.price)
  if ('image' in b) data.image = String(b.image)
  if ('isVeg' in b) data.isVeg = Boolean(b.isVeg)
  if ('spice' in b) data.spice = Math.min(3, Math.max(0, Number(b.spice) || 0))
  if ('available' in b) data.available = Boolean(b.available)
  if ('tag' in b) data.tag = b.tag || null
  if ('trackStock' in b) data.trackStock = Boolean(b.trackStock)
  if ('stock' in b) data.stock = Math.max(0, Number(b.stock) || 0)
  if ('lowStockAt' in b) data.lowStockAt = Math.max(0, Number(b.lowStockAt) || 5)
  if ('prepMinutes' in b) data.prepMinutes = Math.max(0, Math.min(120, Number(b.prepMinutes) || 0))
  const updated = await prisma.dish.update({ where: { id: before.id }, data })
  const changed = Object.keys(data).filter((k) => before[k] !== updated[k])
  let summary = `Edited "${updated.name}"`
  if (changed.includes('available')) {
    summary = updated.available ? `Made "${updated.name}" available` : `Marked "${updated.name}" sold out`
  } else if (changed.includes('price')) {
    summary = `Price: "${updated.name}" ₹${before.price} → ₹${updated.price}`
  }
  logAudit(req, {
    action: 'update',
    entity: 'dish',
    entityId: updated.id,
    summary,
    metadata: { changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, updated[k]])) },
  })
  res.json({ ...updated, tag: updated.tag || undefined })
}))

api.delete('/admin/menu/:id', requirePerm('menu.delete'), asyncRoute(async (req, res) => {
  const target = await prisma.dish.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Dish not found' })
  const removed = await prisma.dish.delete({ where: { id: target.id } })
  logAudit(req, {
    action: 'delete',
    entity: 'dish',
    entityId: removed.id,
    summary: `Deleted "${removed.name}"`,
    metadata: { name: removed.name, price: removed.price },
  })
  res.json(removed)
}))

// ── Inventory ─────────────────────────────────────────────────────────
api.post('/admin/menu/:id/restock', requirePerm('inventory.manage'), asyncRoute(async (req, res) => {
  const { add, set, lowStockAt } = req.body || {}
  const dish = await prisma.dish.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!dish) return res.status(404).json({ message: 'Dish not found' })

  const data = { trackStock: true }
  if (typeof set === 'number' && set >= 0) data.stock = Math.floor(set)
  else if (typeof add === 'number') data.stock = Math.max(0, dish.stock + Math.floor(add))
  if (typeof lowStockAt === 'number' && lowStockAt >= 0) data.lowStockAt = Math.floor(lowStockAt)
  if (data.stock !== undefined && data.stock > 0) data.available = true

  const updated = await prisma.dish.update({ where: { id: dish.id }, data })
  logAudit(req, {
    action: 'update',
    entity: 'dish',
    entityId: updated.id,
    summary:
      typeof set === 'number'
        ? `Set stock of "${updated.name}" to ${updated.stock}`
        : `Restocked "${updated.name}": ${dish.stock} → ${updated.stock}`,
    metadata: { before: dish.stock, after: updated.stock, lowStockAt: updated.lowStockAt },
  })
  realtime.emitStockEvent('dish:restocked', updated)
  res.json({ ...updated, tag: updated.tag || undefined })
}))

api.get('/admin/inventory/low', requirePerm('inventory.manage'), asyncRoute(async (req, res) => {
  const dishes = await prisma.dish.findMany({
    where: { ...orgScope(req), trackStock: true },
    orderBy: { stock: 'asc' },
  })
  const low = dishes.filter((d) => d.stock <= d.lowStockAt)
  res.json(low.map((d) => ({ ...d, tag: d.tag || undefined })))
}))

api.post(
  '/admin/uploads/image',
  requirePerm('media.upload'),
  (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message })
      if (!req.file) return res.status(400).json({ message: 'No file uploaded' })
      const host = `${req.protocol}://${req.get('host')}`
      res.status(201).json({
        url: `${host}/uploads/${req.file.filename}`,
        filename: req.file.filename,
        size: req.file.size,
      })
    })
  },
)

// ── Cashier / Payments ────────────────────────────────────────────────
api.get('/admin/billing/tables', requirePerm('billing.collect'), asyncRoute(async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { ...orgScope(req), paymentStatus: { not: 'paid' } },
    include: { items: true, rating: true },
  })
  const { toApiOrder } = require('./db')
  const grouped = new Map()
  orders.forEach((raw) => {
    const o = toApiOrder(raw)
    const serviceType = o.serviceType || 'table'
    // Key by type+number so Table 5 and Room 5 are distinct bills.
    const key = `${serviceType}:${o.tableNo}`
    if (!grouped.has(key)) {
      grouped.set(key, { tableNo: String(o.tableNo), serviceType, orders: [], total: 0 })
    }
    const g = grouped.get(key)
    g.orders.push(o)
    g.total += o.amounts?.total || 0
  })
  res.json(Array.from(grouped.values()))
}))

api.post('/admin/orders/:id/pay', requirePerm('billing.collect'), asyncRoute(async (req, res) => {
  const order = await markPaid(req.params.id, { ...(req.body || {}), organizationId: req.user.orgId })
  if (!order) return res.status(404).json({ message: 'Order not found' })
  logAudit(req, {
    action: 'pay',
    entity: 'order',
    entityId: order.id,
    summary: `Paid ₹${order.amounts.total} (${order.payment.method.toUpperCase()}) · ${order.serviceType === 'room' ? 'Room' : 'T'}${order.tableNo}`,
    metadata: { method: order.payment.method, total: order.amounts.total, tip: order.amounts.tip || 0 },
  })
  res.json(order)
}))

api.get('/payments/status', (req, res) => {
  res.json(payments.status())
})

api.post('/payments/razorpay/order/:orderId', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const order = await getOrder(req.params.orderId, { organizationId: org.id })
  if (!order) return res.status(404).json({ message: 'Order not found' })
  if (!payments.configured) {
    return res.status(503).json({ message: 'Razorpay not configured' })
  }
  const rzpOrder = await payments.createOrder({
    amount: order.amounts.total,
    receipt: order.id,
    notes: { tableNo: order.tableNo, sessionId: order.sessionId, orgId: org.id },
  })
  res.json({ ...rzpOrder, keyId: payments.status().keyId })
}))

api.post('/payments/razorpay/verify/:orderId', asyncRoute(async (req, res) => {
  const org = await resolveCustomerOrg(req, res)
  if (!org) return
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
  const ok = payments.verifySignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  })
  if (!ok) return res.status(400).json({ message: 'Invalid signature' })
  const updated = await markPaid(req.params.orderId, {
    method: 'razorpay',
    amountPaid: undefined,
    organizationId: org.id,
  })
  if (!updated) return res.status(404).json({ message: 'Order not found' })
  logAudit(req, {
    action: 'pay',
    entity: 'order',
    entityId: updated.id,
    summary: `Paid ₹${updated.amounts.total} via Razorpay · T${updated.tableNo}`,
    metadata: { rzpPaymentId: razorpay_payment_id, total: updated.amounts.total },
  })
  res.json(updated)
}))

api.post('/admin/orders/:id/split', requirePerm('billing.collect'), asyncRoute(async (req, res) => {
  const order = await getOrder(req.params.id, { organizationId: req.user.orgId })
  if (!order) return res.status(404).json({ message: 'Order not found' })
  const n = Math.max(2, Math.min(10, Number(req.body?.parts) || 2))
  const perTotal = Math.round((order.amounts?.total || 0) / n)
  const perSubtotal = Math.round((order.amounts?.subtotal || 0) / n)
  const perTax = Math.round((order.amounts?.tax || 0) / n)
  res.json({ parts: n, perPersonTotal: perTotal, perPersonSubtotal: perSubtotal, perPersonTax: perTax })
}))

// ── Admin: Tables ─────────────────────────────────────────────────────
async function withOccupancy(table, organizationId) {
  const active = await prisma.order.findFirst({
    where: { organizationId, tableNo: table.number, serviceType: 'table', status: { not: 'served' } },
  })
  return {
    ...table,
    status: active ? 'occupied' : 'available',
    activeOrderId: active?.id || null,
  }
}

async function withRoomOccupancy(room, organizationId) {
  const active = await prisma.order.findFirst({
    where: { organizationId, tableNo: room.number, serviceType: 'room', status: { not: 'served' } },
  })
  return {
    ...room,
    status: active ? 'occupied' : 'available',
    activeOrderId: active?.id || null,
  }
}

api.get('/admin/tables', requirePerm('tables.view'), asyncRoute(async (req, res) => {
  const tables = await prisma.table.findMany({ where: orgScope(req), orderBy: { number: 'asc' } })
  res.json(await Promise.all(tables.map((t) => withOccupancy(t, req.user.orgId))))
}))

api.post('/admin/tables', requirePerm('tables.manage'), asyncRoute(async (req, res) => {
  const { number, seats } = req.body || {}
  if (!number) return res.status(400).json({ message: 'number required' })
  const existing = await prisma.table.findUnique({
    where: { organizationId_number: { organizationId: req.user.orgId, number: String(number) } },
  })
  if (existing) return res.status(409).json({ message: 'Table number already exists' })
  await enforcePlanLimit(req, 'tables')
  const created = await prisma.table.create({
    data: {
      id: `t_${req.user.orgId || 'platform'}_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
      organizationId: req.user.orgId,
      number: String(number),
      seats: Number(seats) || 2,
    },
  })
  logAudit(req, {
    action: 'create',
    entity: 'table',
    entityId: created.number,
    summary: `Added Table ${created.number} (${created.seats} seats)`,
  })
  res.status(201).json(await withOccupancy(created, req.user.orgId))
}))

api.patch('/admin/tables/:number', requirePerm('tables.manage'), asyncRoute(async (req, res) => {
  const target = await prisma.table.findUnique({
    where: { organizationId_number: { organizationId: req.user.orgId, number: req.params.number } },
  })
  if (!target) return res.status(404).json({ message: 'Table not found' })
  const updated = await prisma.table.update({
    where: { id: target.id },
    data: req.body.seats !== undefined ? { seats: Number(req.body.seats) } : {},
  })
  res.json(await withOccupancy(updated, req.user.orgId))
}))

api.delete('/admin/tables/:number', requirePerm('tables.delete'), asyncRoute(async (req, res) => {
  const target = await prisma.table.findUnique({
    where: { organizationId_number: { organizationId: req.user.orgId, number: req.params.number } },
  })
  if (!target) return res.status(404).json({ message: 'Table not found' })
  const occupied = await prisma.order.findFirst({
    where: { organizationId: req.user.orgId, tableNo: req.params.number, serviceType: 'table', status: { not: 'served' } },
  })
  if (occupied) return res.status(409).json({ message: 'Cannot delete an occupied table' })
  const removed = await prisma.table.delete({ where: { id: target.id } })
  logAudit(req, {
    action: 'delete',
    entity: 'table',
    entityId: removed.number,
    summary: `Deleted Table ${removed.number}`,
  })
  res.json(removed)
}))

// ── Admin: Rooms (room-service parallel of tables) ────────────────────
api.get('/admin/rooms', requirePerm('rooms.view'), asyncRoute(async (req, res) => {
  const rooms = await prisma.room.findMany({ where: orgScope(req), orderBy: { number: 'asc' } })
  res.json(await Promise.all(rooms.map((r) => withRoomOccupancy(r, req.user.orgId))))
}))

api.post('/admin/rooms', requirePerm('rooms.manage'), asyncRoute(async (req, res) => {
  const { number } = req.body || {}
  if (!number) return res.status(400).json({ message: 'number required' })
  const existing = await prisma.room.findUnique({
    where: { organizationId_number: { organizationId: req.user.orgId, number: String(number) } },
  })
  if (existing) return res.status(409).json({ message: 'Room number already exists' })
  await enforcePlanLimit(req, 'rooms')
  const created = await prisma.room.create({
    data: {
      id: `r_${req.user.orgId || 'platform'}_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
      organizationId: req.user.orgId,
      number: String(number),
    },
  })
  logAudit(req, {
    action: 'create',
    entity: 'room',
    entityId: created.number,
    summary: `Added Room ${created.number}`,
  })
  res.status(201).json(await withRoomOccupancy(created, req.user.orgId))
}))

api.delete('/admin/rooms/:number', requirePerm('rooms.delete'), asyncRoute(async (req, res) => {
  const target = await prisma.room.findUnique({
    where: { organizationId_number: { organizationId: req.user.orgId, number: req.params.number } },
  })
  if (!target) return res.status(404).json({ message: 'Room not found' })
  const occupied = await prisma.order.findFirst({
    where: { organizationId: req.user.orgId, tableNo: req.params.number, serviceType: 'room', status: { not: 'served' } },
  })
  if (occupied) return res.status(409).json({ message: 'Cannot delete an occupied room' })
  const removed = await prisma.room.delete({ where: { id: target.id } })
  logAudit(req, {
    action: 'delete',
    entity: 'room',
    entityId: removed.number,
    summary: `Deleted Room ${removed.number}`,
  })
  res.json(removed)
}))

// ── Admin: Staff (tenant-scoped) ──────────────────────────────────────
api.get('/admin/staff', requirePerm('staff.view'), asyncRoute(async (req, res) => {
  const users = await prisma.user.findMany({
    where: orgScope(req),
    orderBy: { createdAt: 'asc' },
  })
  res.json(users.map((u) => publicUser(u)))
}))

api.post('/admin/staff', requirePerm('staff.manage'), asyncRoute(async (req, res) => {
  const { name, email, role, password } = req.body || {}
  if (!name || !email || !role || !password) {
    return res.status(400).json({ message: 'name, email, role, password required' })
  }
  if (!['admin', 'manager', 'waiter', 'kitchen', 'cashier'].includes(role)) {
    return res.status(400).json({ message: 'Invalid role for an org-scoped user' })
  }
  const exists = await prisma.user.findUnique({
    where: { email: String(email).toLowerCase() },
  })
  if (exists) return res.status(409).json({ message: 'Email already used' })
  await enforcePlanLimit(req, 'users')
  const user = await prisma.user.create({
    data: {
      id: `u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      organizationId: req.user.orgId,
      name: String(name),
      email: String(email).toLowerCase(),
      role,
      passwordHash: bcrypt.hashSync(String(password), 10),
    },
  })
  logAudit(req, {
    action: 'create',
    entity: 'staff',
    entityId: user.id,
    summary: `Onboarded ${user.name} (${user.role})`,
    metadata: { email: user.email, role: user.role },
  })
  res.status(201).json(publicUser(user))
}))

api.patch('/admin/staff/:id', requirePerm('staff.manage'), asyncRoute(async (req, res) => {
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Staff not found' })

  const { name, role, password, email, active } = req.body || {}
  const data = {}
  if (name) data.name = String(name)
  if (role) {
    if (!['admin', 'manager', 'waiter', 'kitchen', 'cashier'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' })
    }
    data.role = role
  }
  if (password) data.passwordHash = bcrypt.hashSync(String(password), 10)
  // Email change (e.g. replacing an auto-generated default-staff address) —
  // must stay globally unique.
  if (email && String(email).toLowerCase() !== target.email) {
    const next = String(email).toLowerCase()
    const dup = await prisma.user.findUnique({ where: { email: next } })
    if (dup) return res.status(409).json({ message: 'Email already used' })
    data.email = next
  }
  // Activate / deactivate — but never let someone lock themselves out.
  if (typeof active === 'boolean') {
    if (target.id === req.user.sub && !active) {
      return res.status(400).json({ message: 'You cannot deactivate your own account' })
    }
    data.active = active
  }
  const updated = await prisma.user.update({ where: { id: target.id }, data })
  const changed = []
  if (name) changed.push('name')
  if (role) changed.push('role')
  if (password) changed.push('password')
  if ('email' in data) changed.push('email')
  if ('active' in data) changed.push(data.active ? 'activated' : 'deactivated')
  logAudit(req, {
    action: 'update',
    entity: 'staff',
    entityId: updated.id,
    summary: `Updated ${updated.name} (${changed.join(', ')})`,
    metadata: { changed, role: updated.role },
  })
  res.json(publicUser(updated))
}))

api.delete('/admin/staff/:id', requirePerm('staff.manage'), asyncRoute(async (req, res) => {
  if (req.params.id === req.user.sub) {
    return res.status(400).json({ message: 'You cannot delete your own account' })
  }
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Staff not found' })
  const removed = await prisma.user.delete({ where: { id: target.id } })
  logAudit(req, {
    action: 'delete',
    entity: 'staff',
    entityId: removed.id,
    summary: `Removed ${removed.name} (${removed.role})`,
  })
  res.json(publicUser(removed))
}))

// ── Permissions catalog + per-user overrides ──────────────────────────
api.get('/admin/permissions/catalog', requirePerm('staff.view'), (req, res) => {
  res.json({ permissions: PERMISSIONS, roleDefaults: ROLE_PERMISSIONS })
})

api.patch('/admin/staff/:id/permissions', requirePerm('staff.permissions'), asyncRoute(async (req, res) => {
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Staff not found' })

  if (target.id === req.user.sub) {
    return res.status(400).json({
      message: 'You cannot change your own permissions — ask another admin.',
    })
  }

  const { permissions: incoming, reset } = req.body || {}
  let data
  if (reset === true) {
    data = { permissions: null }
  } else {
    const cleaned = sanitizePermissions(incoming)
    if (cleaned === null) {
      return res.status(400).json({ message: 'permissions must be an array' })
    }
    data = { permissions: JSON.stringify(cleaned) }
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data })
  const before = effectivePermissions(target)
  const after = effectivePermissions(updated)
  const added = after.filter((p) => !before.includes(p))
  const removed = before.filter((p) => !after.includes(p))
  logAudit(req, {
    action: 'update',
    entity: 'staff',
    entityId: updated.id,
    summary: reset === true
      ? `Reset ${updated.name}'s permissions to ${updated.role} defaults`
      : `Updated ${updated.name}'s permissions (+${added.length} / −${removed.length})`,
    metadata: { added, removed, custom: updated.permissions != null },
  })
  res.json(publicUser(updated))
}))

// ── Expenses ──────────────────────────────────────────────────────────
const EXPENSE_CATEGORIES = ['salary', 'grocery', 'electricity', 'rent', 'maintenance', 'other']

api.get('/admin/expenses', requirePerm('expenses.view'), asyncRoute(async (req, res) => {
  const { from, to } = req.query
  const where = { ...orgScope(req) }
  if (from || to) {
    where.date = {}
    if (from) where.date.gte = new Date(from)
    if (to) where.date.lte = new Date(to)
  }
  const expenses = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } })
  res.json({ categories: EXPENSE_CATEGORIES, expenses: expenses.map(exposeExpense) })
}))

api.post('/admin/expenses', requirePerm('expenses.manage'), asyncRoute(async (req, res) => {
  const { category, amount, note, date } = req.body || {}
  if (!category || !EXPENSE_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: 'Invalid category' })
  }
  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ message: 'Amount must be positive' })
  }
  const created = await prisma.expense.create({
    data: {
      id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      organizationId: req.user.orgId,
      category,
      amount: Number(amount),
      note: String(note || ''),
      date: date ? new Date(date) : new Date(),
      createdBy: req.user.name || '',
    },
  })
  logAudit(req, {
    action: 'create',
    entity: 'expense',
    entityId: created.id,
    summary: `Logged ₹${created.amount} (${created.category})`,
    metadata: { category: created.category, amount: created.amount },
  })
  res.status(201).json(exposeExpense(created))
}))

api.patch('/admin/expenses/:id', requirePerm('expenses.manage'), asyncRoute(async (req, res) => {
  const target = await prisma.expense.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Expense not found' })
  const data = {}
  const { category, amount, note, date } = req.body || {}
  if (category) {
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: 'Invalid category' })
    }
    data.category = category
  }
  if (amount !== undefined) data.amount = Number(amount)
  if (note !== undefined) data.note = String(note)
  if (date) data.date = new Date(date)
  const updated = await prisma.expense.update({ where: { id: target.id }, data })
  res.json(exposeExpense(updated))
}))

api.delete('/admin/expenses/:id', requirePerm('expenses.delete'), asyncRoute(async (req, res) => {
  const target = await prisma.expense.findFirst({
    where: { id: req.params.id, ...orgScope(req) },
  })
  if (!target) return res.status(404).json({ message: 'Expense not found' })
  const removed = await prisma.expense.delete({ where: { id: target.id } })
  logAudit(req, {
    action: 'delete',
    entity: 'expense',
    entityId: removed.id,
    summary: `Removed expense ₹${removed.amount} (${removed.category})`,
  })
  res.json(exposeExpense(removed))
}))

// ── Admin: Loyalty (org-scoped) ───────────────────────────────────────
api.get('/admin/loyalty', requirePerm('loyalty.view'), asyncRoute(async (req, res) => {
  const { q, take = 100, skip = 0 } = req.query
  const where = { ...orgScope(req) }
  if (q) where.OR = [{ phone: { contains: String(q) } }, { name: { contains: String(q) } }]

  const [items, total] = await Promise.all([
    prisma.loyaltyMember.findMany({
      where,
      orderBy: { points: 'desc' },
      take: Math.min(500, Number(take) || 100),
      skip: Number(skip) || 0,
    }),
    prisma.loyaltyMember.count({ where }),
  ])
  const summary = await prisma.loyaltyMember.aggregate({
    where: orgScope(req),
    _count: true,
    _sum: { points: true, totalSpent: true, visits: true },
  })
  res.json({
    total,
    summary: {
      members: summary._count || 0,
      points: summary._sum?.points || 0,
      spent: summary._sum?.totalSpent || 0,
      visits: summary._sum?.visits || 0,
    },
    items: items.map((m) => ({
      ...m,
      joinedAt: m.joinedAt.toISOString(),
      lastVisitAt: m.lastVisitAt.toISOString(),
    })),
  })
}))

api.get('/admin/loyalty/:phone/history', requirePerm('loyalty.view'), asyncRoute(async (req, res) => {
  const member = await loyalty.findMember(req.params.phone, req.user.orgId)
  if (!member) return res.status(404).json({ message: 'Member not found' })
  const orders = await prisma.order.findMany({
    where: { organizationId: req.user.orgId, loyaltyPhone: member.phone },
    orderBy: { createdAt: 'desc' },
    include: { items: true },
    take: 50,
  })
  res.json({
    member: {
      ...member,
      joinedAt: member.joinedAt.toISOString(),
      lastVisitAt: member.lastVisitAt.toISOString(),
    },
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber ?? null,
      tableNo: o.tableNo,
      serviceType: o.serviceType || 'table',
      total: o.total,
      pointsEarned: o.pointsEarned,
      pointsRedeemed: o.pointsRedeemed,
      paymentStatus: o.paymentStatus,
      createdAt: o.createdAt.toISOString(),
    })),
  })
}))

// ── Admin: Audit log ──────────────────────────────────────────────────
api.get('/admin/audit', requirePerm('audit.view'), asyncRoute(async (req, res) => {
  const { entity, action, actorId, q, from, to, take = 100, skip = 0 } = req.query
  const where = { ...orgScope(req) }
  if (entity) where.entity = entity
  if (action) where.action = action
  if (actorId) where.actorId = actorId
  if (from || to) {
    where.createdAt = {}
    if (from) where.createdAt.gte = new Date(from)
    if (to) where.createdAt.lte = new Date(to)
  }
  if (q) {
    where.OR = [
      { summary: { contains: String(q) } },
      { actorName: { contains: String(q) } },
      { entityId: { contains: String(q) } },
    ]
  }
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Number(take) || 100),
      skip: Number(skip) || 0,
    }),
    prisma.auditLog.count({ where }),
  ])
  res.json({
    total,
    items: items.map((a) => ({
      ...a,
      createdAt: a.createdAt.toISOString(),
      metadata: safeParse(a.metadata),
    })),
  })
}))

function safeParse(s) {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

function exposeExpense(e) {
  return {
    ...e,
    date: e.date.toISOString(),
    createdAt: e.createdAt.toISOString(),
  }
}

// ── Reports (org-scoped) ──────────────────────────────────────────────
function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

api.get('/admin/reports/summary', requirePerm('reports.view'), asyncRoute(async (req, res) => {
  const { from, to } = req.query
  const fromDate = from ? startOfDay(from) : startOfDay(Date.now() - 6 * 86400000)
  const toDate = to ? new Date(to) : new Date()

  const orders = await prisma.order.findMany({
    where: { ...orgScope(req), createdAt: { gte: fromDate, lte: toDate } },
    include: { items: true },
  })
  const completed = orders.filter((o) => o.status === 'served')

  const revenueTotal = completed.reduce((s, o) => s + (o.total || 0), 0)
  const taxTotal = completed.reduce((s, o) => s + (o.tax || 0), 0)
  const subtotalTotal = completed.reduce((s, o) => s + (o.subtotal || 0), 0)

  const dayMap = new Map()
  for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
    dayMap.set(d.toISOString().slice(0, 10), {
      date: d.toISOString().slice(0, 10),
      revenue: 0,
      orders: 0,
    })
  }
  completed.forEach((o) => {
    const key = o.createdAt.toISOString().slice(0, 10)
    const row = dayMap.get(key)
    if (row) {
      row.revenue += o.total
      row.orders += 1
    }
  })
  const daily = Array.from(dayMap.values())

  const dishCounts = new Map()
  completed.forEach((o) =>
    o.items.forEach((it) => {
      const prev = dishCounts.get(it.name) || { name: it.name, qty: 0, revenue: 0 }
      prev.qty += it.qty
      prev.revenue += it.qty * it.price
      dishCounts.set(it.name, prev)
    }),
  )
  const popular = Array.from(dishCounts.values()).sort((a, b) => b.qty - a.qty).slice(0, 10)

  const paymentMix = { upi: 0, card: 0, counter: 0 }
  completed.forEach((o) => {
    const m = o.paymentMethod || 'counter'
    paymentMix[m] = (paymentMix[m] || 0) + (o.total || 0)
  })

  // Settlements: how customers actually paid. Based on *paid* orders (money
  // collected) rather than served orders, broken down by method so the
  // restaurant can see the QR-vs-cash split at a glance.
  const SETTLE_METHODS = ['qr', 'counter', 'upi', 'card', 'razorpay']
  const byMethod = Object.fromEntries(SETTLE_METHODS.map((m) => [m, { count: 0, amount: 0 }]))
  let settledTotal = 0
  let settledCount = 0
  orders
    .filter((o) => o.paymentStatus === 'paid')
    .forEach((o) => {
      const m = SETTLE_METHODS.includes(o.paymentMethod) ? o.paymentMethod : 'counter'
      byMethod[m].count += 1
      byMethod[m].amount += o.total || 0
      settledTotal += o.total || 0
      settledCount += 1
    })
  const settlements = { total: settledTotal, count: settledCount, byMethod }

  // Service mix: tables (dine-in) vs rooms (room service). Based on served
  // orders so it lines up with the revenue figure above.
  const serviceMix = {
    table: { orders: 0, revenue: 0 },
    room: { orders: 0, revenue: 0 },
    takeaway: { orders: 0, revenue: 0 },
  }
  // Per-room revenue, so a hotel can see which rooms order the most.
  const roomMap = new Map()
  completed.forEach((o) => {
    const svc = serviceMix[o.serviceType] ? o.serviceType : 'table'
    serviceMix[svc].orders += 1
    serviceMix[svc].revenue += o.total || 0
    if (svc === 'room') {
      const prev = roomMap.get(o.tableNo) || { number: o.tableNo, orders: 0, revenue: 0 }
      prev.orders += 1
      prev.revenue += o.total || 0
      roomMap.set(o.tableNo, prev)
    }
  })
  const rooms = Array.from(roomMap.values()).sort((a, b) => b.revenue - a.revenue)

  // Ratings cascade with Order, so filter ratings via their parent order's org.
  const ratings = await prisma.rating.findMany({
    where: {
      createdAt: { gte: fromDate, lte: toDate },
      order: orgScope(req),
    },
    orderBy: { createdAt: 'desc' },
  })
  const avg = (key) =>
    ratings.length
      ? Math.round((ratings.reduce((s, r) => s + (r[key] || 0), 0) / ratings.length) * 10) / 10
      : 0

  const inWindow = await prisma.expense.findMany({
    where: { ...orgScope(req), date: { gte: fromDate, lte: toDate } },
  })
  const expenseTotal = inWindow.reduce((s, e) => s + e.amount, 0)
  const expensesByCategory = inWindow.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount
    return acc
  }, {})
  const profit = revenueTotal - expenseTotal
  const margin = revenueTotal ? Math.round((profit / revenueTotal) * 1000) / 10 : 0

  res.json({
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    totals: {
      revenue: revenueTotal,
      orders: orders.length,
      completedOrders: completed.length,
      subtotal: subtotalTotal,
      tax: taxTotal,
      avgTicket: completed.length ? Math.round(revenueTotal / completed.length) : 0,
      expenses: expenseTotal,
      profit,
      margin,
    },
    daily,
    popular,
    payments: paymentMix,
    settlements,
    serviceMix,
    rooms,
    expensesByCategory,
    ratings: {
      count: ratings.length,
      food: avg('food'),
      service: avg('service'),
      overall: avg('overall'),
      comments: ratings
        .filter((r) => r.comments)
        .slice(0, 5)
        .map((r) => ({ comments: r.comments, overall: r.overall, createdAt: r.createdAt.toISOString() })),
    },
  })
}))

// ── Super Admin (platform-scope) ──────────────────────────────────────
api.get('/super-admin/overview', requirePerm('organizations.view'), asyncRoute(async (req, res) => {
  const [orgCount, activeOrgs, orderCount, revenueAgg, userCount, orgsForBilling, overdueAgg, pendingAgg] = await Promise.all([
    prisma.organization.count(),
    prisma.organization.count({ where: { active: true } }),
    prisma.order.count(),
    prisma.order.aggregate({ _sum: { total: true }, where: { paymentStatus: 'paid' } }),
    prisma.user.count({ where: { role: { not: 'super_admin' } } }),
    prisma.organization.findMany({ where: { active: true } }),
    prisma.invoice.aggregate({
      where: { status: 'pending', dueAt: { lt: new Date() } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.invoice.aggregate({
      where: { status: 'pending' },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ])
  // MRR: sum of monthlyPrice for non-trial, currently-active subscriptions.
  let mrr = 0
  let trials = 0
  let pastDue = 0
  for (const o of orgsForBilling) {
    const s = billingSummary(o)
    if (s.status === 'trial' || s.status === 'expiring' && planMeta(o.subscriptionPlan).isTrial) trials++
    if (s.status === 'past_due') pastDue++
    if (!s.blocked && o.subscriptionPlan !== 'trial' && o.subscriptionPlan !== 'enterprise') {
      mrr += s.monthlyPrice || 0
    }
  }
  res.json({
    organizations: orgCount,
    activeOrganizations: activeOrgs,
    totalOrders: orderCount,
    totalRevenue: revenueAgg._sum?.total || 0,
    totalUsers: userCount,
    billing: {
      mrr,
      trials,
      pastDue,
      overdueAmount: overdueAgg._sum?.amount || 0,
      overdueCount: overdueAgg._count?._all || 0,
      pendingAmount: pendingAgg._sum?.amount || 0,
      pendingCount: pendingAgg._count?._all || 0,
    },
  })
}))

api.get('/super-admin/organizations', requirePerm('organizations.view'), asyncRoute(async (req, res) => {
  const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'asc' } })
  const withStats = await Promise.all(orgs.map(async (o) => {
    const [userCount, dishCount, tableCount, roomCount, orderCount, revenue, invoiceAgg] = await Promise.all([
      prisma.user.count({ where: { organizationId: o.id } }),
      prisma.dish.count({ where: { organizationId: o.id } }),
      prisma.table.count({ where: { organizationId: o.id } }),
      prisma.room.count({ where: { organizationId: o.id } }),
      prisma.order.count({ where: { organizationId: o.id } }),
      prisma.order.aggregate({
        where: { organizationId: o.id, paymentStatus: 'paid' },
        _sum: { total: true },
      }),
      prisma.invoice.aggregate({
        where: { organizationId: o.id },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ])
    const limits = effectiveLimits(o)
    return shapeOrgForApi(o, {
      subscription: billingSummary(o),
      limits,
      usage: {
        tables: { used: tableCount, limit: limits.tables },
        rooms: { used: roomCount, limit: limits.rooms },
        users: { used: userCount, limit: limits.users },
        dishes: { used: dishCount, limit: limits.dishes },
      },
      stats: {
        users: userCount,
        dishes: dishCount,
        tables: tableCount,
        rooms: roomCount,
        orders: orderCount,
        revenue: revenue._sum?.total || 0,
        invoiceCount: invoiceAgg._count?._all || 0,
        invoiceTotal: invoiceAgg._sum?.amount || 0,
      },
    })
  }))
  res.json(withStats)
}))

api.post('/super-admin/organizations', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const b = req.body || {}
  const plan = PLANS[b.subscriptionPlan] ? b.subscriptionPlan : 'trial'
  let created, adminUser
  try {
    ({ org: created, adminUser } = await createOrgWithAdmin({
      name: b.name,
      slug: b.slug,
      admin: b.admin,
      plan,
      monthlyPrice: Number.isFinite(b.monthlyPrice) ? b.monthlyPrice : undefined,
      active: b.active !== false,
      orgExtra: b,
    }))
  } catch (e) {
    if (e.status && e.expose) return res.status(e.status).json({ message: e.message, field: e.field })
    throw e
  }

  logAudit(req, {
    action: 'create',
    entity: 'organization',
    entityId: created.id,
    summary: `Created organization "${created.name}" on ${plan} plan with admin ${adminUser.email}`,
    metadata: { slug: created.slug, plan, adminEmail: adminUser.email },
  })
  res.status(201).json(shapeOrgForApi(created, {
    subscription: billingSummary(created),
    limits: effectiveLimits(created),
    usage: {
      tables: { used: 0, limit: effectiveLimits(created).tables },
      rooms: { used: 0, limit: effectiveLimits(created).rooms },
      users: { used: 1 + DEFAULT_STAFF.length, limit: effectiveLimits(created).users },
      dishes: { used: 0, limit: effectiveLimits(created).dishes },
    },
    stats: { users: 1 + DEFAULT_STAFF.length, dishes: 0, tables: 0, rooms: 0, orders: 0, revenue: 0, invoiceCount: 0, invoiceTotal: 0 },
    admin: { id: adminUser.id, name: adminUser.name, email: adminUser.email },
  }))
}))

api.patch('/super-admin/organizations/:id', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const before = await prisma.organization.findUnique({ where: { id: req.params.id } })
  if (!before) return res.status(404).json({ message: 'Organization not found' })
  const b = req.body || {}
  const data = {}
  for (const key of ['name', 'logoUrl', 'themeColor', 'address', 'gstNumber', 'contactPhone', 'contactEmail', 'timezone', 'locale', 'currency', 'currencySymbol', 'taxLabel']) {
    if (key in b) data[key] = String(b[key])
  }
  if ('gstRate' in b && Number.isFinite(Number(b.gstRate))) {
    data.gstRate = Math.max(0, Math.min(100, Number(b.gstRate)))
  }
  if ('businessHours' in b) {
    // Accept either an array (we JSON-encode) or a string already JSON-encoded.
    data.businessHours = typeof b.businessHours === 'string' ? b.businessHours : JSON.stringify(b.businessHours || [])
  }
  if ('active' in b) data.active = Boolean(b.active)
  // Channel entitlements — the platform admin grants or revokes which ordering
  // channels a tenant is ALLOWED to offer. `null` clears the override and falls
  // back to the plan default; true/false pins it. A revoked channel is hidden
  // from the tenant's own settings and can't be enabled or ordered from.
  for (const key of ['tableOrderingAllowed', 'roomOrderingAllowed', 'takeawayOrderingAllowed']) {
    if (!(key in b)) continue
    data[key] = b[key] === null ? null : Boolean(b[key])
  }
  if ('slug' in b) data.slug = String(b.slug).toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (Number.isFinite(b.monthlyPrice)) data.monthlyPrice = b.monthlyPrice
  // Quota overrides. `null` removes the override and falls back to the plan
  // default; an integer pins the cap. Anything else is ignored.
  for (const key of ['maxTables', 'maxRooms', 'maxUsers', 'maxDishes']) {
    if (!(key in b)) continue
    if (b[key] === null) data[key] = null
    else if (Number.isFinite(b[key]) && b[key] >= 0) data[key] = b[key]
  }

  // Changing the plan re-stamps billing dates so the new cycle starts now.
  // Trial -> paid: clears trialEndsAt, opens a fresh period. Paid -> trial:
  // clears period dates and reopens a fresh trial.
  if ('subscriptionPlan' in b && PLANS[b.subscriptionPlan] && b.subscriptionPlan !== before.subscriptionPlan) {
    const plan = b.subscriptionPlan
    data.subscriptionPlan = plan
    data.subscriptionStatus = planMeta(plan).isTrial ? 'trial' : 'active'
    data.cancelAtPeriodEnd = false
    const meta = planMeta(plan)
    if (!Number.isFinite(b.monthlyPrice)) data.monthlyPrice = meta.monthlyPrice
    Object.assign(data, periodDatesFor(plan))
  }

  const updated = await prisma.organization.update({ where: { id: before.id }, data })
  const changed = Object.keys(data).filter((k) => String(before[k]) !== String(updated[k]))
  logAudit(req, {
    action: 'update',
    entity: 'organization',
    entityId: updated.id,
    summary: changed.includes('active')
      ? `${updated.active ? 'Activated' : 'Deactivated'} "${updated.name}"`
      : changed.includes('subscriptionPlan')
        ? `Changed "${updated.name}" plan: ${before.subscriptionPlan} → ${updated.subscriptionPlan}`
        : `Updated "${updated.name}" (${changed.join(', ')})`,
    metadata: { changed },
  })
  res.json(shapeOrgForApi(updated, { subscription: billingSummary(updated), limits: effectiveLimits(updated) }))
}))

// Extend the subscription by one billing cycle. Optionally records an
// invoice for the cycle that was just extended (markPaid=true marks it
// paid in the same call).
api.post('/super-admin/organizations/:id/subscription/extend', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.params.id } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  const plan = org.subscriptionPlan
  const meta = planMeta(plan)
  if (!meta.durationDays) {
    return res.status(400).json({ message: `Plan "${plan}" has no fixed cycle; nothing to extend.` })
  }
  // Extend from whichever date is later: now, or the current period end.
  const now = new Date()
  const ref = meta.isTrial
    ? (org.trialEndsAt && org.trialEndsAt > now ? org.trialEndsAt : now)
    : (org.currentPeriodEnd && org.currentPeriodEnd > now ? org.currentPeriodEnd : now)
  const nextEnd = addDays(ref, meta.durationDays)

  const patch = meta.isTrial
    ? { trialEndsAt: nextEnd, subscriptionStatus: 'trial' }
    : {
        currentPeriodStart: org.currentPeriodEnd && org.currentPeriodEnd > now ? org.currentPeriodEnd : now,
        currentPeriodEnd: nextEnd,
        subscriptionStatus: 'active',
        cancelAtPeriodEnd: false,
      }

  const updated = await prisma.organization.update({ where: { id: org.id }, data: patch })

  let invoice = null
  if (req.body?.recordInvoice && plan !== 'trial') {
    const year = new Date().getFullYear()
    const seq = (await prisma.invoice.count({
      where: { number: { startsWith: `INV-${year}-` } },
    })) + 1
    invoice = await prisma.invoice.create({
      data: {
        id: `inv_${Math.random().toString(36).slice(2, 10)}`,
        organizationId: org.id,
        number: formatInvoiceNumber(year, seq),
        plan,
        amount: Number.isFinite(req.body.amount) ? req.body.amount : (org.monthlyPrice || meta.monthlyPrice),
        currency: 'INR',
        status: req.body.markPaid ? 'paid' : 'pending',
        periodStart: patch.currentPeriodStart,
        periodEnd: patch.currentPeriodEnd,
        dueAt: patch.currentPeriodStart,
        paidAt: req.body.markPaid ? now : null,
        paymentMethod: String(req.body.paymentMethod || ''),
        notes: String(req.body.notes || ''),
      },
    })
  }

  logAudit(req, {
    action: 'subscription.extend',
    entity: 'organization',
    entityId: org.id,
    summary: `Extended "${org.name}" ${plan} cycle to ${nextEnd.toISOString().slice(0, 10)}`,
    metadata: { plan, nextEnd: nextEnd.toISOString(), invoiceId: invoice?.id || null },
  })
  res.json({ organization: updated, invoice })
}))

// Cancel: either immediately (status=cancelled, periods cleared) or at
// period end (cancelAtPeriodEnd=true; access stays until then).
api.post('/super-admin/organizations/:id/subscription/cancel', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.params.id } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  const immediate = !!req.body?.immediate
  const patch = immediate
    ? {
        subscriptionStatus: 'cancelled',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        trialEndsAt: null,
      }
    : { cancelAtPeriodEnd: true }
  const updated = await prisma.organization.update({ where: { id: org.id }, data: patch })
  logAudit(req, {
    action: 'subscription.cancel',
    entity: 'organization',
    entityId: org.id,
    summary: immediate
      ? `Cancelled "${org.name}" immediately`
      : `Scheduled "${org.name}" to cancel at period end`,
    metadata: { immediate },
  })
  res.json(shapeOrgForApi(updated, { subscription: billingSummary(updated), limits: effectiveLimits(updated) }))
}))

api.post('/super-admin/organizations/:id/subscription/reactivate', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.params.id } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  const dates = periodDatesFor(org.subscriptionPlan)
  const updated = await prisma.organization.update({
    where: { id: org.id },
    data: {
      ...dates,
      subscriptionStatus: planMeta(org.subscriptionPlan).isTrial ? 'trial' : 'active',
      cancelAtPeriodEnd: false,
    },
  })
  logAudit(req, {
    action: 'subscription.reactivate',
    entity: 'organization',
    entityId: org.id,
    summary: `Reactivated "${org.name}" on ${org.subscriptionPlan} plan`,
  })
  res.json(shapeOrgForApi(updated, { subscription: billingSummary(updated), limits: effectiveLimits(updated) }))
}))

// Invoices — list/create/update. Creating an invoice with markPaid=true is
// the off-platform "received payment" flow.
api.get('/super-admin/organizations/:id/invoices', requirePerm('organizations.view'), asyncRoute(async (req, res) => {
  const list = await prisma.invoice.findMany({
    where: { organizationId: req.params.id },
    orderBy: { createdAt: 'desc' },
  })
  res.json(list)
}))

api.post('/super-admin/organizations/:id/invoices', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const org = await prisma.organization.findUnique({ where: { id: req.params.id } })
  if (!org) return res.status(404).json({ message: 'Organization not found' })
  const b = req.body || {}
  const year = new Date().getFullYear()
  const seq = (await prisma.invoice.count({
    where: { number: { startsWith: `INV-${year}-` } },
  })) + 1
  const periodStart = b.periodStart ? new Date(b.periodStart) : new Date()
  const periodEnd = b.periodEnd
    ? new Date(b.periodEnd)
    : addDays(periodStart, planMeta(org.subscriptionPlan).durationDays || 30)
  const created = await prisma.invoice.create({
    data: {
      id: `inv_${Math.random().toString(36).slice(2, 10)}`,
      organizationId: org.id,
      number: formatInvoiceNumber(year, seq),
      plan: org.subscriptionPlan,
      amount: Number.isFinite(b.amount) ? b.amount : (org.monthlyPrice || planMeta(org.subscriptionPlan).monthlyPrice),
      currency: 'INR',
      status: b.markPaid ? 'paid' : (b.status || 'pending'),
      periodStart,
      periodEnd,
      dueAt: b.dueAt ? new Date(b.dueAt) : periodStart,
      paidAt: b.markPaid ? new Date() : null,
      paymentMethod: String(b.paymentMethod || ''),
      notes: String(b.notes || ''),
    },
  })
  logAudit(req, {
    action: 'invoice.create',
    entity: 'invoice',
    entityId: created.id,
    summary: `${b.markPaid ? 'Recorded payment' : 'Issued invoice'} ${created.number} for "${org.name}" (₹${created.amount})`,
    metadata: { organizationId: org.id, status: created.status },
  })
  res.status(201).json(created)
}))

api.patch('/super-admin/invoices/:id', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } })
  if (!inv) return res.status(404).json({ message: 'Invoice not found' })
  const b = req.body || {}
  const data = {}
  if ('status' in b) {
    data.status = String(b.status)
    if (b.status === 'paid' && !inv.paidAt) data.paidAt = new Date()
    if (b.status !== 'paid') data.paidAt = null
  }
  if ('paymentMethod' in b) data.paymentMethod = String(b.paymentMethod)
  if ('notes' in b) data.notes = String(b.notes)
  if (Number.isFinite(b.amount)) data.amount = b.amount
  const updated = await prisma.invoice.update({ where: { id: inv.id }, data })
  logAudit(req, {
    action: 'invoice.update',
    entity: 'invoice',
    entityId: updated.id,
    summary: `Invoice ${updated.number} → ${updated.status}`,
    metadata: { organizationId: updated.organizationId },
  })
  res.json(updated)
}))

// ── Super Admin: subscription plans (managed catalog) ─────────────────
const intOrNull = (v) =>
  v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : null

function planBodyToRow(b, id) {
  return {
    id,
    label: String(b.label || id),
    monthlyPrice: Math.max(0, Math.floor(Number(b.monthlyPrice) || 0)),
    durationDays: intOrNull(b.durationDays),
    billable: !!b.billable,
    isTrial: !!b.isTrial,
    maxTables: intOrNull(b.limits ? b.limits.tables : b.maxTables),
    maxRooms: intOrNull(b.limits ? b.limits.rooms : b.maxRooms),
    maxUsers: intOrNull(b.limits ? b.limits.users : b.maxUsers),
    maxDishes: intOrNull(b.limits ? b.limits.dishes : b.maxDishes),
    channelTable: (b.channels ? b.channels.table : b.channelTable) !== false,
    channelRoom: !!(b.channels ? b.channels.room : b.channelRoom),
    channelTakeaway: !!(b.channels ? b.channels.takeaway : b.channelTakeaway),
    contactSales: !!b.contactSales,
    recommended: !!b.recommended,
    selfServe: (b.selfServe === undefined ? true : b.selfServe) !== false,
    sortOrder: Math.floor(Number(b.sortOrder) || 0),
    active: (b.active === undefined ? true : b.active) !== false,
  }
}

api.get('/super-admin/plans', requirePerm('organizations.view'), asyncRoute(async (req, res) => {
  res.json({ plans: planList() })
}))

api.post('/super-admin/plans', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const b = req.body || {}
  const id = String(b.id || b.key || b.label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!id) return res.status(400).json({ message: 'A plan id/name is required.' })
  if (planExists(id)) return res.status(409).json({ message: `A plan "${id}" already exists.` })
  const created = await prisma.plan.create({ data: planBodyToRow(b, id) })
  await loadPlans()
  logAudit(req, { action: 'plan.create', entity: 'plan', entityId: created.id, summary: `Created plan "${created.label}"` })
  res.status(201).json(planMeta(id))
}))

api.patch('/super-admin/plans/:id', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const existing = await prisma.plan.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ message: 'Plan not found' })
  const row = planBodyToRow({ ...existing, ...req.body, limits: req.body?.limits, channels: req.body?.channels }, existing.id)
  delete row.id
  const updated = await prisma.plan.update({ where: { id: existing.id }, data: row })
  await loadPlans()
  logAudit(req, { action: 'plan.update', entity: 'plan', entityId: updated.id, summary: `Updated plan "${updated.label}"` })
  res.json(planMeta(updated.id))
}))

api.delete('/super-admin/plans/:id', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const existing = await prisma.plan.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ message: 'Plan not found' })
  const inUse = await prisma.organization.count({ where: { subscriptionPlan: existing.id } })
  if (inUse) return res.status(409).json({ message: `Cannot delete "${existing.label}" — ${inUse} organization(s) are on it.` })
  await prisma.plan.delete({ where: { id: existing.id } })
  await loadPlans()
  logAudit(req, { action: 'plan.delete', entity: 'plan', entityId: existing.id, summary: `Deleted plan "${existing.label}"` })
  res.json({ ok: true })
}))

// ── Super Admin: subscription coupons ─────────────────────────────────
function couponView(c) {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    discountType: c.discountType,
    discountValue: c.discountValue,
    appliesToPlans: String(c.appliesToPlans || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxRedemptions: c.maxRedemptions,
    redemptions: c.redemptions,
    expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    active: c.active,
    createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : null,
  }
}

function couponBodyToData(b) {
  const type = b.discountType === 'flat' ? 'flat' : 'percent'
  let value = Math.floor(Number(b.discountValue) || 0)
  value = type === 'percent' ? Math.max(1, Math.min(100, value)) : Math.max(1, value)
  const plansCsv = Array.isArray(b.appliesToPlans)
    ? b.appliesToPlans.filter(Boolean).join(',')
    : String(b.appliesToPlans || '')
  return {
    description: String(b.description || ''),
    discountType: type,
    discountValue: value,
    appliesToPlans: plansCsv,
    maxRedemptions: intOrNull(b.maxRedemptions),
    expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
    active: b.active === undefined ? true : Boolean(b.active),
  }
}

api.get('/super-admin/coupons', requirePerm('organizations.view'), asyncRoute(async (req, res) => {
  const list = await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } })
  res.json({ coupons: list.map(couponView) })
}))

api.post('/super-admin/coupons', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const b = req.body || {}
  const code = String(b.code || '').trim().toUpperCase().replace(/\s+/g, '')
  if (!code) return res.status(400).json({ message: 'A coupon code is required.' })
  if (await prisma.coupon.findUnique({ where: { code } })) {
    return res.status(409).json({ message: `Coupon "${code}" already exists.` })
  }
  const created = await prisma.coupon.create({
    data: { id: `cpn_${Math.random().toString(36).slice(2, 10)}`, code, ...couponBodyToData(b) },
  })
  logAudit(req, { action: 'coupon.create', entity: 'coupon', entityId: created.id, summary: `Created coupon ${created.code}` })
  res.status(201).json(couponView(created))
}))

api.patch('/super-admin/coupons/:id', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ message: 'Coupon not found' })
  const updated = await prisma.coupon.update({ where: { id: existing.id }, data: couponBodyToData({ ...existing, ...req.body }) })
  logAudit(req, { action: 'coupon.update', entity: 'coupon', entityId: updated.id, summary: `Updated coupon ${updated.code}` })
  res.json(couponView(updated))
}))

api.delete('/super-admin/coupons/:id', requirePerm('organizations.manage'), asyncRoute(async (req, res) => {
  const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ message: 'Coupon not found' })
  await prisma.coupon.delete({ where: { id: existing.id } })
  logAudit(req, { action: 'coupon.delete', entity: 'coupon', entityId: existing.id, summary: `Deleted coupon ${existing.code}` })
  res.json({ ok: true })
}))

app.use('/api', api)

// Friendly health endpoint at the root so deploys / uptime checks don't see
// a bare 404. The real surface lives under /api.
app.get('/', (req, res) => {
  res.json({
    service: 'Masala Story API',
    status: 'ok',
    docs: '/api/platform/branding',
  })
})

app.use((err, req, res, next) => {
  if (err instanceof PlanLimitError) {
    return res.status(402).json({
      message: err.message,
      code: err.code,
      resource: err.resource,
      limit: err.limit,
    })
  }
  console.error(err)
  res.status(500).json({ message: err?.message || 'Server error' })
})

const server = http.createServer(app)
const io = new Server(server, { cors: { origin: '*' } })
realtime.attach(io)

const PORT = process.env.PORT || 5050
// Bind to 0.0.0.0 (all IPv4 interfaces). Without an explicit host Node binds to
// IPv6 "::" only, which Render's IPv4 port-scanner can't reach — causing the
// "no open ports detected" deploy failure on the platform.
const HOST = '0.0.0.0'
server.listen(PORT, HOST, async () => {
  console.log(`Masala Story API + Sockets → http://${HOST}:${PORT}`)
  try {
    // Load (and seed on first run) the subscription plans into the cache so the
    // synchronous billing helpers serve live, admin-managed plan data.
    await loadPlans()
  } catch (e) {
    console.error('Failed to load plans (using built-in defaults)', e)
  }
  try {
    await resumePendingOrders()
  } catch (e) {
    console.error('Failed to resume orders', e)
  }
})
