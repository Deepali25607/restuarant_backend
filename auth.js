const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { prisma } = require('./db')
const { effectivePermissions, defaultsForRole } = require('./permissions')
const { billingSummary, isAccessBlocked } = require('./billing')

const JWT_SECRET = process.env.JWT_SECRET || 'masala-story-dev-secret-change-me'
const JWT_EXPIRES = '12h'

function sign(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      orgId: user.organizationId || null,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES },
  )
}

function publicUser(u, organization = null) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active !== false,
    organizationId: u.organizationId || null,
    organization: organization
      ? {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          logoUrl: organization.logoUrl,
          themeColor: organization.themeColor,
          timezone: organization.timezone,
          locale: organization.locale,
          currency: organization.currency,
          currencySymbol: organization.currencySymbol,
          gstRate: organization.gstRate,
          taxLabel: organization.taxLabel,
          gstNumber: organization.gstNumber,
          address: organization.address,
          contactPhone: organization.contactPhone,
          contactEmail: organization.contactEmail,
          businessHours: safeParseHours(organization.businessHours),
          subscription: billingSummary(organization),
        }
      : null,
    permissions: effectivePermissions(u),
    hasCustomPermissions: u.permissions != null,
  }
}

function safeParseHours(raw) {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

async function login(email, password) {
  if (!email || !password) return null
  const user = await prisma.user.findUnique({
    where: { email: String(email).toLowerCase() },
  })
  if (!user) return null
  const ok = await bcrypt.compare(String(password), user.passwordHash)
  if (!ok) return null

  // A deactivated staff account keeps its data but can't sign in.
  if (user.active === false) {
    return { error: 'This account has been deactivated. Please contact your administrator.' }
  }

  // Block sign-in for tenant users whose organization has been deactivated
  // OR whose subscription has expired / been cancelled past the period end.
  let organization = null
  if (user.organizationId) {
    organization = await prisma.organization.findUnique({
      where: { id: user.organizationId },
    })
    if (!organization) return { error: 'Organization not found' }
    if (!organization.active) return { error: 'Organization is deactivated' }
    const billing = billingSummary(organization)
    if (isAccessBlocked(billing.status)) {
      const msg = billing.status === 'expired'
        ? 'Subscription expired. Please contact the platform team to renew.'
        : billing.status === 'past_due'
          ? 'Subscription is past due. Please clear the outstanding invoice.'
          : 'Subscription has been cancelled. Please contact the platform team.'
      return { error: msg }
    }
  }

  return { user: publicUser(user, organization), token: sign(user) }
}

// Lightweight middleware that ONLY verifies the JWT and stamps req.user.
// Useful for endpoints where you only need "is signed in" without a perm check.
function requireAuth() {
  return (req, res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ message: 'Auth token required' })
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      req.user = payload
      next()
    } catch {
      return res.status(401).json({ message: 'Invalid or expired token' })
    }
  }
}

module.exports = { login, requireAuth, sign, publicUser, defaultsForRole }
