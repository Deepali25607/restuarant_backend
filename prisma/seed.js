/* Multi-tenant seed: one platform user + two demo organizations, each
   with its own staff, categories, dishes, and tables. Safe to re-run. */
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { categories, menu, tables, rooms } = require('../data/seed')
const { platformUsers, staffForOrg } = require('../data/users')
const { periodDatesFor, planMeta } = require('../billing')

const prisma = new PrismaClient()

const ORGANIZATIONS = [
  {
    id: 'org_masala',
    name: 'Masala Story',
    slug: 'masala-story',
    logoUrl: '',
    themeColor: '#ea580c', // chilli orange
    address: '1st Floor, Spice Lane, Bengaluru',
    gstNumber: '29AAACM1234A1ZN',
    contactPhone: '+91 80 4000 0001',
    contactEmail: 'hello@masalastory.com',
    subscriptionPlan: 'enterprise',
    active: true,
  },
  {
    id: 'org_spice',
    name: 'Spice Junction',
    slug: 'spice-junction',
    logoUrl: '',
    themeColor: '#16a34a', // mint green to clearly differ from Masala Story
    address: 'Indiranagar 12th Main, Bengaluru',
    gstNumber: '29AAACS5678B1ZK',
    contactPhone: '+91 80 4000 0002',
    contactEmail: 'hello@spicejunction.com',
    subscriptionPlan: 'monthly',
    active: true,
  },
]

async function seedOrg(org) {
  // Stamp realistic billing dates so the SuperAdmin console has something to
  // show on a clean seed. Enterprise gets no auto-expiry; monthly gets a
  // fresh 30-day cycle anchored to today.
  const meta = planMeta(org.subscriptionPlan)
  const dates = periodDatesFor(org.subscriptionPlan)
  const billing = {
    subscriptionStatus: org.subscriptionPlan === 'trial' ? 'trial' : 'active',
    monthlyPrice: meta.monthlyPrice,
    cancelAtPeriodEnd: false,
    ...dates,
  }
  await prisma.organization.upsert({
    where: { id: org.id },
    update: {
      name: org.name,
      slug: org.slug,
      themeColor: org.themeColor,
      address: org.address,
      gstNumber: org.gstNumber,
      contactPhone: org.contactPhone,
      contactEmail: org.contactEmail,
      subscriptionPlan: org.subscriptionPlan,
      active: org.active,
      ...billing,
    },
    create: { ...org, ...billing },
  })

  // Staff for this org
  for (const u of staffForOrg(org.id, org.name)) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, organizationId: u.organizationId },
      create: {
        id: u.id,
        organizationId: u.organizationId,
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: u.passwordHash,
      },
    })
  }

  // Categories scoped to org. Use suffix so ids are unique across orgs.
  for (const c of categories) {
    const id = `${org.id}_${c.id}`
    await prisma.category.upsert({
      where: { id },
      update: { name: c.name, emoji: c.emoji, order: c.order, organizationId: org.id },
      create: { id, organizationId: org.id, name: c.name, emoji: c.emoji, order: c.order },
    })
  }

  // Dishes — same recipe set per org but ids are org-prefixed and
  // categoryId is rewritten to the org-specific category id.
  for (const d of menu) {
    const id = `${org.id}_${d.id}`
    const categoryId = `${org.id}_${d.categoryId}`
    await prisma.dish.upsert({
      where: { id },
      update: {
        organizationId: org.id,
        name: d.name,
        description: d.description,
        categoryId,
        price: d.price,
        image: d.image,
        isVeg: d.isVeg,
        spice: d.spice,
        available: d.available,
        tag: d.tag || null,
      },
      create: {
        id,
        organizationId: org.id,
        name: d.name,
        description: d.description,
        categoryId,
        price: d.price,
        image: d.image,
        isVeg: d.isVeg,
        spice: d.spice,
        available: d.available,
        tag: d.tag || null,
      },
    })
  }

  // Tables — synthetic id, number stays human-friendly. The (orgId, number)
  // unique constraint means two orgs can both have a "Table 1".
  for (const t of tables) {
    const id = `${org.id}_t${t.number}`
    await prisma.table.upsert({
      where: { id },
      update: { seats: t.seats, number: t.number, organizationId: org.id },
      create: { id, organizationId: org.id, number: t.number, seats: t.seats },
    })
  }

  // Rooms — room-service locations, parallel to tables.
  for (const r of rooms) {
    const id = `${org.id}_r${r.number}`
    await prisma.room.upsert({
      where: { id },
      update: { number: r.number, organizationId: org.id },
      create: { id, organizationId: org.id, number: r.number },
    })
  }
}

async function main() {
  // Platform-level users (no organizationId).
  for (const u of platformUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, organizationId: null },
      create: {
        id: u.id,
        organizationId: null,
        name: u.name,
        email: u.email,
        role: u.role,
        passwordHash: u.passwordHash,
      },
    })
  }

  for (const org of ORGANIZATIONS) {
    await seedOrg(org)
  }

  const counts = {
    organizations: await prisma.organization.count(),
    users: await prisma.user.count(),
    categories: await prisma.category.count(),
    dishes: await prisma.dish.count(),
    tables: await prisma.table.count(),
  }
  console.log('Seeded:', counts)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
