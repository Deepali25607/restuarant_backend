const bcrypt = require('bcryptjs')

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  WAITER: 'waiter',
  KITCHEN: 'kitchen',
  CASHIER: 'cashier',
}

// Platform-level user with no organizationId. Manages tenants.
const platformUsers = [
  {
    id: 'u_super',
    name: 'Platform Owner',
    email: 'super@platform.com',
    role: ROLES.SUPER_ADMIN,
    passwordHash: bcrypt.hashSync('super@123', 10),
  },
]

// Returns the set of org-scoped staff for a given organization.
function staffForOrg(orgId, suffix = '') {
  return [
    {
      id: `u_admin_${orgId}`,
      organizationId: orgId,
      name: `Restaurant Admin${suffix ? ` (${suffix})` : ''}`,
      email: `admin@${orgId.replace(/_/g, '-')}.com`,
      role: ROLES.ADMIN,
      passwordHash: bcrypt.hashSync('admin@123', 10),
    },
    {
      id: `u_manager_${orgId}`,
      organizationId: orgId,
      name: `Aarav Sharma${suffix ? ` (${suffix})` : ''}`,
      email: `manager@${orgId.replace(/_/g, '-')}.com`,
      role: ROLES.MANAGER,
      passwordHash: bcrypt.hashSync('manager@123', 10),
    },
    {
      id: `u_kitchen_${orgId}`,
      organizationId: orgId,
      name: `Chef Rohan${suffix ? ` (${suffix})` : ''}`,
      email: `kitchen@${orgId.replace(/_/g, '-')}.com`,
      role: ROLES.KITCHEN,
      passwordHash: bcrypt.hashSync('kitchen@123', 10),
    },
    {
      id: `u_cashier_${orgId}`,
      organizationId: orgId,
      name: `Priya Nair${suffix ? ` (${suffix})` : ''}`,
      email: `cashier@${orgId.replace(/_/g, '-')}.com`,
      role: ROLES.CASHIER,
      passwordHash: bcrypt.hashSync('cashier@123', 10),
    },
  ]
}

module.exports = { ROLES, platformUsers, staffForOrg }
