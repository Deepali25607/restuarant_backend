const jwt = require('jsonwebtoken')
const { prisma } = require('./db')
const { billingSummary, isAccessBlocked } = require('./billing')

const JWT_SECRET = process.env.JWT_SECRET || 'masala-story-dev-secret-change-me'

// Catalog of every fine-grained capability in the system.
// Grouped for nicer UI presentation in the admin matrix.
const PERMISSIONS = [
  // Platform-scope (super_admin only) — managing tenants themselves.
  { group: 'Platform', key: 'organizations.view', label: 'View all organizations', platform: true },
  { group: 'Platform', key: 'organizations.manage', label: 'Create / edit / deactivate organizations', platform: true },

  { group: 'Dashboard', key: 'dashboard.view', label: 'View dashboard' },

  { group: 'Orders', key: 'orders.view', label: 'View live orders' },
  { group: 'Orders', key: 'orders.update', label: 'Change order status' },

  { group: 'Kitchen', key: 'kitchen.view', label: 'Open kitchen screen' },

  { group: 'Menu', key: 'menu.manage', label: 'Add / edit dishes' },
  { group: 'Menu', key: 'menu.delete', label: 'Delete dishes' },
  { group: 'Menu', key: 'inventory.manage', label: 'Restock & low-stock' },
  { group: 'Menu', key: 'media.upload', label: 'Upload dish images' },

  { group: 'Tables', key: 'tables.view', label: 'View tables' },
  { group: 'Tables', key: 'tables.manage', label: 'Add / edit tables' },
  { group: 'Tables', key: 'tables.delete', label: 'Delete tables' },

  { group: 'Rooms', key: 'rooms.view', label: 'View rooms' },
  { group: 'Rooms', key: 'rooms.manage', label: 'Add / edit rooms' },
  { group: 'Rooms', key: 'rooms.delete', label: 'Delete rooms' },

  { group: 'Billing', key: 'billing.collect', label: 'Take payments & split' },

  { group: 'Settings', key: 'settings.manage', label: 'Manage restaurant settings & payment QR' },

  { group: 'Expenses', key: 'expenses.view', label: 'View expenses' },
  { group: 'Expenses', key: 'expenses.manage', label: 'Add / edit expenses' },
  { group: 'Expenses', key: 'expenses.delete', label: 'Delete expenses' },

  { group: 'Reports', key: 'reports.view', label: 'View P&L reports' },

  { group: 'Loyalty', key: 'loyalty.view', label: 'View loyalty members' },

  { group: 'Audit', key: 'audit.view', label: 'View audit log' },

  { group: 'Staff', key: 'staff.view', label: 'View staff roster' },
  { group: 'Staff', key: 'staff.manage', label: 'Create / edit / remove staff' },
  { group: 'Staff', key: 'staff.permissions', label: 'Grant or revoke permissions' },
]

const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key)
const TENANT_PERMISSIONS = PERMISSIONS.filter((p) => !p.platform).map((p) => p.key)
const PLATFORM_PERMISSIONS = PERMISSIONS.filter((p) => p.platform).map((p) => p.key)

// Defaults applied when a user has no custom override.
const ROLE_PERMISSIONS = {
  super_admin: PLATFORM_PERMISSIONS, // platform owner: only platform perms by default
  admin: TENANT_PERMISSIONS, // org admin: every tenant perm, no platform perms
  manager: [
    'dashboard.view',
    'orders.view',
    'orders.update',
    'menu.manage',
    'inventory.manage',
    'media.upload',
    'tables.view',
    'tables.manage',
    'rooms.view',
    'rooms.manage',
    'billing.collect',
    'expenses.view',
    'expenses.manage',
    'reports.view',
    'loyalty.view',
    'audit.view',
    'staff.view',
    'settings.manage',
  ],
  cashier: [
    'dashboard.view',
    'orders.view',
    'orders.update',
    'tables.view',
    'rooms.view',
    'billing.collect',
    'loyalty.view',
  ],
  waiter: [
    'dashboard.view',
    'orders.view',
    'orders.update',
    'tables.view',
    'rooms.view',
  ],
  kitchen: [
    'kitchen.view',
    'orders.view',
    'orders.update',
    'inventory.manage',
  ],
}

function defaultsForRole(role) {
  return ROLE_PERMISSIONS[role] ? [...ROLE_PERMISSIONS[role]] : []
}

function parseOverride(raw) {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.filter((p) => ALL_PERMISSIONS.includes(p))
  } catch {
    /* fall through */
  }
  return null
}

function effectivePermissions(user) {
  if (!user) return []
  const override = parseOverride(user.permissions)
  return override !== null ? override : defaultsForRole(user.role)
}

function sanitize(list) {
  if (!Array.isArray(list)) return null
  const seen = new Set()
  const out = []
  for (const p of list) {
    if (typeof p === 'string' && ALL_PERMISSIONS.includes(p) && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

// Middleware: verify token + load fresh user + require all listed permissions.
// Passing no args means "any signed-in user is fine".
function requirePerm(...needed) {
  return async (req, res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return res.status(401).json({ message: 'Auth token required' })

    let payload
    try {
      payload = jwt.verify(token, JWT_SECRET)
    } catch {
      return res.status(401).json({ message: 'Invalid or expired token' })
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } })
    if (!user) return res.status(401).json({ message: 'Account no longer exists' })

    // Super-admins can target any org by setting an explicit `x-target-org`
    // header. Tenant users are always pinned to their own org.
    const isSuper = user.role === 'super_admin'
    const targetOrg = req.headers['x-target-org']
    const orgId = isSuper ? (targetOrg ? String(targetOrg) : null) : user.organizationId

    if (!isSuper && !orgId) {
      return res.status(403).json({ message: 'Account is not attached to an organization' })
    }

    // Live subscription gate for tenant requests: a token issued before the
    // billing cycle expired must not keep working past it. Super-admins are
    // exempt because they hold the keys regardless of tenant state.
    if (!isSuper && user.organizationId) {
      const org = await prisma.organization.findUnique({ where: { id: user.organizationId } })
      if (!org || !org.active) {
        return res.status(403).json({ message: 'Organization is deactivated' })
      }
      const summary = billingSummary(org)
      if (isAccessBlocked(summary.status)) {
        return res.status(402).json({
          message: 'Subscription is not active',
          code: 'subscription_blocked',
          status: summary.status,
        })
      }
    }

    const perms = effectivePermissions(user)
    if (needed.length && !needed.every((p) => perms.includes(p))) {
      return res.status(403).json({ message: 'Missing required permissions' })
    }

    req.user = {
      sub: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      orgId, // resolved org scope for this request — may be null (super_admin browsing globally)
      isSuper,
      permissions: perms,
    }
    next()
  }
}

// Builds a Prisma `where` fragment that scopes a query to the current user's
// organization. Super-admins with no targetOrg see the global view (no filter).
function orgScope(req) {
  if (!req.user || req.user.isSuper) {
    if (req.user?.orgId) return { organizationId: req.user.orgId }
    return {} // super_admin with no targetOrg — no filter
  }
  return { organizationId: req.user.orgId }
}

module.exports = {
  PERMISSIONS,
  ALL_PERMISSIONS,
  TENANT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  ROLE_PERMISSIONS,
  defaultsForRole,
  effectivePermissions,
  sanitize,
  requirePerm,
  orgScope,
}
