const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Reshape a DB order into the API shape the frontend already understands.
// Stored as flat columns; exposed as nested `payment` + `amounts`.
function toApiOrder(o) {
  if (!o) return null
  return {
    id: o.id,
    tableNo: o.tableNo,
    sessionId: o.sessionId,
    items: (o.items || []).map((it) => ({
      dishId: it.dishId,
      name: it.name,
      price: it.price,
      qty: it.qty,
      instructions: it.instructions || '',
    })),
    payment: {
      method: o.paymentMethod,
      status: o.paymentStatus,
      paidAt: o.paymentPaidAt ? o.paymentPaidAt.toISOString() : undefined,
      amountPaid: o.paymentAmountPaid ?? undefined,
      claimedAt: o.paymentClaimedAt ? o.paymentClaimedAt.toISOString() : undefined,
    },
    amounts: {
      subtotal: o.subtotal,
      tax: o.tax,
      tip: o.tip,
      discount: o.discount || 0,
      total: o.total,
    },
    loyalty: o.loyaltyPhone
      ? {
          phone: o.loyaltyPhone,
          pointsEarned: o.pointsEarned || 0,
          pointsRedeemed: o.pointsRedeemed || 0,
        }
      : null,
    status: o.status,
    queuePosition: o.queuePosition,
    etaMinutes: o.etaMinutes,
    rating: o.rating
      ? {
          food: o.rating.food,
          service: o.rating.service,
          overall: o.rating.overall,
          comments: o.rating.comments,
          createdAt: o.rating.createdAt.toISOString(),
        }
      : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  }
}

module.exports = { prisma, toApiOrder }
