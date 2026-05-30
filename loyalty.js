const { prisma } = require('./db')

// Earn 1 point per ₹100 spent (rounded down). Each point = ₹1 off on redeem.
const EARN_PER_RUPEES = 100
const REDEMPTION_VALUE = 1

// Normalize phone: strip everything but digits, keep last 10 (Indian default).
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D+/g, '')
  if (digits.length < 10) return null
  return digits.slice(-10)
}

// Loyalty membership is per-organization: the same phone number can belong to
// different organizations independently. All lookups are scoped by orgId.
async function findMember(rawPhone, organizationId) {
  const phone = normalizePhone(rawPhone)
  if (!phone || !organizationId) return null
  return prisma.loyaltyMember.findUnique({
    where: { organizationId_phone: { organizationId, phone } },
  })
}

async function upsertMember({ phone, name, organizationId }) {
  const p = normalizePhone(phone)
  if (!p || !organizationId) return null
  return prisma.loyaltyMember.upsert({
    where: { organizationId_phone: { organizationId, phone: p } },
    update: name ? { name } : {},
    create: {
      id: `lm_${organizationId}_${p}`,
      organizationId,
      phone: p,
      name: String(name || ''),
    },
  })
}

function maxRedeemable(points, billable) {
  const cap = Math.floor((billable || 0) / REDEMPTION_VALUE)
  return Math.max(0, Math.min(points, cap))
}

async function validateRedemption({ phone, points, billable, organizationId }) {
  if (!points) return { discount: 0, redeemed: 0, member: null }
  const member = await findMember(phone, organizationId)
  if (!member) return { discount: 0, redeemed: 0, member: null, error: 'No loyalty account for this phone' }
  const usable = maxRedeemable(Math.floor(points), billable)
  if (usable !== Math.floor(points)) {
    return {
      discount: 0,
      redeemed: 0,
      member,
      error: `Can only redeem up to ${usable} points right now`,
    }
  }
  return { discount: usable * REDEMPTION_VALUE, redeemed: usable, member }
}

async function applyRedemption(tx, { phone, redeemed, organizationId }) {
  if (!redeemed) return null
  const p = normalizePhone(phone)
  if (!p || !organizationId) return null
  return tx.loyaltyMember.update({
    where: { organizationId_phone: { organizationId, phone: p } },
    data: { points: { decrement: redeemed } },
  })
}

async function accrueOnPaid(order) {
  const phone = normalizePhone(order.loyaltyPhone)
  const organizationId = order.organizationId
  if (!phone || !organizationId) return null
  const billable = (order.subtotal || 0) + (order.tax || 0) - (order.discount || 0)
  const earned = Math.max(0, Math.floor(billable / EARN_PER_RUPEES))
  if (!earned) return null
  const member = await prisma.loyaltyMember.upsert({
    where: { organizationId_phone: { organizationId, phone } },
    update: {
      points: { increment: earned },
      totalSpent: { increment: order.total || 0 },
      visits: { increment: 1 },
      lastVisitAt: new Date(),
    },
    create: {
      id: `lm_${organizationId}_${phone}`,
      organizationId,
      phone,
      points: earned,
      totalSpent: order.total || 0,
      visits: 1,
      lastVisitAt: new Date(),
    },
  })
  await prisma.order.update({
    where: { id: order.id },
    data: { pointsEarned: earned },
  })
  return { earned, member }
}

module.exports = {
  EARN_PER_RUPEES,
  REDEMPTION_VALUE,
  normalizePhone,
  findMember,
  upsertMember,
  validateRedemption,
  applyRedemption,
  accrueOnPaid,
}
