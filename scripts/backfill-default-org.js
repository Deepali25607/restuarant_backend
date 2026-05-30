/* One-shot: assigns all existing tenant data to the default Masala Story org.
   Safe to re-run; only updates rows where organizationId is null. */
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')

const DEFAULT_ORG_ID = 'org_masala'

const prisma = new PrismaClient()

async function main() {
  // Make sure the default org exists, but don't trample any other field if
  // the seed has already created it.
  await prisma.organization.upsert({
    where: { id: DEFAULT_ORG_ID },
    update: {},
    create: {
      id: DEFAULT_ORG_ID,
      name: 'Masala Story',
      slug: 'masala-story',
      themeColor: '#ea580c',
      address: '1st Floor, Spice Lane, Bengaluru',
      gstNumber: '29AAACM1234A1ZN',
      contactPhone: '+91 80 4000 0001',
      contactEmail: 'hello@masalastory.com',
      subscriptionPlan: 'enterprise',
      active: true,
    },
  })

  const updates = {}
  // Super-admin users (role super_admin) keep null orgId; everyone else
  // gets routed to the default org.
  updates.users = await prisma.user.updateMany({
    where: { organizationId: null, role: { not: 'super_admin' } },
    data: { organizationId: DEFAULT_ORG_ID },
  })
  updates.categories = await prisma.category.updateMany({
    where: { organizationId: null },
    data: { organizationId: DEFAULT_ORG_ID },
  })
  updates.dishes = await prisma.dish.updateMany({
    where: { organizationId: null },
    data: { organizationId: DEFAULT_ORG_ID },
  })
  updates.orders = await prisma.order.updateMany({
    where: { organizationId: null },
    data: { organizationId: DEFAULT_ORG_ID },
  })
  updates.expenses = await prisma.expense.updateMany({
    where: { organizationId: null },
    data: { organizationId: DEFAULT_ORG_ID },
  })
  updates.audit = await prisma.auditLog.updateMany({
    where: { organizationId: null },
    data: { organizationId: DEFAULT_ORG_ID },
  })

  console.log('Backfilled rows into', DEFAULT_ORG_ID, ':', updates)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
