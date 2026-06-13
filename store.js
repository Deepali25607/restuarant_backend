const { prisma, toApiOrder } = require('./db')
const realtime = require('./realtime')
const loyalty = require('./loyalty')
const settings = require('./settings')

const STATUS_FLOW = ['received', 'queued', 'preparing', 'cooking', 'ready', 'served']

// The calendar day (YYYY-MM-DD) in the restaurant's local timezone. Used to
// key the per-day order counter so numbers reset at local midnight, not UTC.
function dayKeyFor(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    // Bad/unknown timezone string — fall back to IST so we still get a number.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  }
}

// Every order create/list/lookup is org-scoped. `organizationId` is taken from
// the customer's QR-scan context (URL or `x-organization-id` header) for
// public flows, and from the JWT-authenticated user for admin flows.
async function createOrder(payload) {
  const { organizationId } = payload
  if (!organizationId) {
    const err = new Error('organizationId required')
    err.status = 400
    throw err
  }
  const id = `o_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  // Takeaway has no table/room; give it a short human-friendly pickup token so
  // staff can call it out and the customer knows which order to collect.
  const serviceType = ['room', 'takeaway'].includes(payload.serviceType)
    ? payload.serviceType
    : 'table'
  const tableNo = serviceType === 'takeaway' ? id.slice(-4).toUpperCase() : String(payload.tableNo)
  const activeCount = await prisma.order.count({
    where: { organizationId, status: { not: 'served' } },
  })

  // Dishes must belong to the same org as the order, otherwise the customer
  // is mixing menus across tenants.
  const dishIds = [...new Set(payload.items.map((it) => String(it.dishId)))]
  const orderedDishes = await prisma.dish.findMany({
    where: { id: { in: dishIds }, organizationId },
  })
  if (orderedDishes.length !== dishIds.length) {
    const err = new Error('Some dishes do not belong to this organization')
    err.status = 400
    throw err
  }
  const dishById = new Map(orderedDishes.map((d) => [d.id, d]))
  const trackedBefore = orderedDishes.filter((d) => d.trackStock)
  const beforeById = new Map(trackedBefore.map((d) => [d.id, d]))

  const etaConfig = await settings.getEtaConfig()
  const etaItems = payload.items.map((it) => ({
    qty: Number(it.qty) || 1,
    prepMinutes: dishById.get(String(it.dishId))?.prepMinutes || 0,
  }))
  const etaMinutes = settings.estimateEtaMinutes({
    items: etaItems,
    queueAhead: activeCount,
    config: etaConfig,
  })

  const subtotal = payload.amounts?.subtotal || 0
  // Authoritative tax: recompute from the org's gstRate so a client can't
  // forge a low GST amount. Falls back to the client value only if the org
  // row is missing for some reason.
  let taxRate = 5
  let orgTimezone = 'Asia/Kolkata'
  if (organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { gstRate: true, timezone: true },
    })
    if (org && Number.isFinite(org.gstRate)) taxRate = org.gstRate
    if (org?.timezone) orgTimezone = org.timezone
  }
  const dayKey = dayKeyFor(new Date(), orgTimezone)
  const tax = Math.round(subtotal * (taxRate / 100))
  const requestedRedeem = Math.max(0, Number(payload.loyalty?.redeem) || 0)
  const redemption = requestedRedeem
    ? await loyalty.validateRedemption({
        phone: payload.loyalty?.phone,
        points: requestedRedeem,
        billable: subtotal + tax,
        organizationId,
      })
    : { discount: 0, redeemed: 0 }
  if (redemption.error) {
    const err = new Error(redemption.error)
    err.status = 400
    throw err
  }

  const discount = redemption.discount || 0
  const finalTotal = Math.max(0, subtotal + tax - discount + (payload.amounts?.tip || 0))
  const loyaltyPhone = loyalty.normalizePhone(payload.loyalty?.phone)

  const order = await prisma.$transaction(async (tx) => {
    for (const it of payload.items) {
      const prev = beforeById.get(String(it.dishId))
      if (!prev) continue
      const qty = Math.max(1, Number(it.qty) || 1)
      const nextStock = Math.max(0, prev.stock - qty)
      await tx.dish.update({
        where: { id: prev.id },
        data: {
          stock: nextStock,
          available: nextStock > 0 && prev.available,
        },
      })
    }
    if (loyaltyPhone && redemption.redeemed) {
      await loyalty.applyRedemption(tx, {
        phone: loyaltyPhone,
        redeemed: redemption.redeemed,
        organizationId,
      })
    }
    // Daily order number: atomically bump the (org, day) counter. The unique
    // constraint serializes concurrent creates so no two orders share a number.
    const counter = await tx.dailyOrderCounter.upsert({
      where: { organizationId_dayKey: { organizationId, dayKey } },
      create: { organizationId, dayKey, value: 1 },
      update: { value: { increment: 1 } },
    })
    const orderNumber = counter.value
    return tx.order.create({
      data: {
        id,
        organizationId,
        tableNo,
        serviceType,
        orderNumber,
        sessionId: payload.sessionId || null,
        paymentMethod: payload.payment?.method || 'counter',
        paymentStatus: 'pending',
        // Pay-later orders cook before payment; everyone else waits for the
        // cashier to confirm payment before the kitchen can advance them.
        payLater: payload.payment?.method === 'later',
        subtotal,
        tax,
        tip: payload.amounts?.tip || 0,
        discount,
        total: finalTotal,
        status: 'received',
        queuePosition: activeCount + 1,
        etaMinutes,
        loyaltyPhone: loyaltyPhone || null,
        pointsRedeemed: redemption.redeemed || 0,
        items: {
          create: payload.items.map((it) => ({
            dishId: String(it.dishId),
            name: String(it.name),
            price: Number(it.price),
            qty: Number(it.qty),
            instructions: String(it.instructions || ''),
          })),
        },
      },
      include: { items: true, rating: true },
    })
  })

  for (const prev of trackedBefore) {
    const after = await prisma.dish.findUnique({ where: { id: prev.id } })
    if (!after) continue
    const crossedZero = prev.stock > 0 && after.stock === 0
    const crossedLow =
      prev.stock > prev.lowStockAt && after.stock <= prev.lowStockAt && after.stock > 0
    if (crossedZero) realtime.emitStockEvent('dish:outOfStock', after)
    else if (crossedLow) realtime.emitStockEvent('dish:lowStock', after)
  }

  const api = toApiOrder(order)
  scheduleOrderProgress(api)
  realtime.emitNewOrder(api)
  return api
}

async function getOrder(id, { organizationId } = {}) {
  const o = await prisma.order.findUnique({
    where: { id },
    include: { items: true, rating: true },
  })
  if (!o) return null
  // Scope check: if a caller passed an orgId, refuse cross-tenant reads.
  if (organizationId && o.organizationId && o.organizationId !== organizationId) {
    return null
  }
  return toApiOrder(o)
}

async function listOrders({ status, organizationId } = {}) {
  const where = {}
  if (organizationId) where.organizationId = organizationId
  if (status) {
    const wanted = String(status).split(',')
    where.status = { in: wanted }
  }
  const orders = await prisma.order.findMany({
    where,
    include: { items: true, rating: true },
    orderBy: { createdAt: 'desc' },
  })
  return orders.map(toApiOrder)
}

async function setOrderStatus(id, status, { organizationId } = {}) {
  if (!STATUS_FLOW.includes(status)) return null
  const existing = await prisma.order.findUnique({ where: { id } })
  if (!existing) return null
  if (organizationId && existing.organizationId !== organizationId) return null
  // Payment gate: an order stays at 'received' until the cashier confirms
  // payment. Only then can the kitchen push it forward (queued → … → served).
  // Pay-later orders are the explicit exception — they cook while still unpaid.
  if (status !== 'received' && existing.paymentStatus !== 'paid' && !existing.payLater) {
    const err = new Error('Confirm payment at the Cashier desk before sending this order to the kitchen')
    err.status = 409
    err.code = 'payment_required'
    throw err
  }
  try {
    const updated = await prisma.order.update({
      where: { id },
      data: { status },
      include: { items: true, rating: true },
    })
    const api = toApiOrder(updated)
    realtime.emitOrderUpdate(api)
    return api
  } catch {
    return null
  }
}

// Records the customer's chosen payment method after they place the order
// (e.g. "qr" to pay by scanning the restaurant's QR, or "counter" for cash).
// Purely informational for the cashier — it never marks the order paid. Only
// mutable while the order is unpaid; once a cashier settles it, the recorded
// method is authoritative and a late client tap must not overwrite it.
async function setPaymentMethod(id, method, { organizationId } = {}) {
  const ALLOWED = ['qr', 'counter', 'upi', 'card', 'razorpay']
  if (!ALLOWED.includes(method)) {
    const err = new Error('Invalid payment method')
    err.status = 400
    throw err
  }
  const existing = await prisma.order.findUnique({ where: { id } })
  if (!existing) return null
  if (organizationId && existing.organizationId !== organizationId) return null
  if (existing.paymentStatus === 'paid') {
    const fresh = await prisma.order.findUnique({
      where: { id },
      include: { items: true, rating: true },
    })
    return toApiOrder(fresh)
  }
  // Picking "qr" means the customer tapped "I've paid by QR" — stamp the claim
  // so the cashier sees a standing "confirm this" flag even if they weren't
  // watching when it happened.
  const claimed = method === 'qr'
  const data = { paymentMethod: method }
  if (claimed) data.paymentClaimedAt = new Date()
  const updated = await prisma.order.update({
    where: { id },
    data,
    include: { items: true, rating: true },
  })
  const api = toApiOrder(updated)
  realtime.emitOrderUpdate(api)
  if (claimed) realtime.emitPaymentClaim(api)
  return api
}

async function markPaid(id, { method, tip, amountPaid, loyaltyPhone, organizationId }) {
  const existing = await prisma.order.findUnique({ where: { id } })
  if (!existing) return null
  if (organizationId && existing.organizationId !== organizationId) return null
  const data = {
    paymentStatus: 'paid',
    paymentPaidAt: new Date(),
  }
  if (method) data.paymentMethod = method
  if (typeof tip === 'number' && tip > 0) {
    data.tip = tip
    data.total = existing.subtotal + existing.tax - (existing.discount || 0) + tip
  }
  if (typeof amountPaid === 'number') data.paymentAmountPaid = amountPaid
  const normalizedPhone = loyaltyPhone ? loyalty.normalizePhone(loyaltyPhone) : null
  if (normalizedPhone && !existing.loyaltyPhone) {
    data.loyaltyPhone = normalizedPhone
  }
  const updated = await prisma.order.update({
    where: { id },
    data,
    include: { items: true, rating: true },
  })
  if (updated.loyaltyPhone && existing.paymentStatus !== 'paid') {
    await loyalty.accrueOnPaid(updated).catch(() => {})
  }
  const fresh = await prisma.order.findUnique({
    where: { id },
    include: { items: true, rating: true },
  })
  const api = toApiOrder(fresh || updated)
  realtime.emitPaymentUpdate(api)
  // Payment just cleared — start the auto-progress clock now (no-op when
  // auto-progress is disabled; orders then wait for a manual push).
  if (existing.paymentStatus !== 'paid') {
    scheduleOrderProgress(api)
  }
  return api
}

async function saveRating(orderId, { food, service, overall, comments, organizationId }) {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return null
  if (organizationId && order.organizationId !== organizationId) return null
  const data = {
    food: Number(food) || 0,
    service: Number(service) || 0,
    overall: Number(overall) || 0,
    comments: String(comments || '').slice(0, 1000),
  }
  await prisma.rating.upsert({
    where: { orderId },
    update: data,
    create: { orderId, ...data },
  })
  const updated = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, rating: true },
  })
  return toApiOrder(updated)
}

async function scheduleOrderProgress(order) {
  const cfg = await settings.getEtaConfig()
  if (!cfg.autoProgress) return
  const stepMs = Math.max(1000, cfg.statusStepSeconds * 1000)
  STATUS_FLOW.slice(1).forEach((targetStatus, i) => {
    setTimeout(async () => {
      const fresh = await settings.getEtaConfig()
      if (!fresh.autoProgress) return
      const current = await prisma.order.findUnique({ where: { id: order.id } })
      if (!current) return
      // Respect the payment gate — don't auto-advance an unpaid order, unless
      // it's a pay-later order (which is allowed to cook before payment).
      if (current.paymentStatus !== 'paid' && !current.payLater) return
      const curIdx = STATUS_FLOW.indexOf(current.status)
      if (curIdx >= i + 1) return
      try {
        await setOrderStatus(order.id, targetStatus)
      } catch {
        /* gate or race — leave it for the next tick / manual push */
      }
    }, stepMs * (i + 1))
  })
}

// Cashier action: defer payment on an order. Flips it to pay-later so it can
// be sent to the kitchen now, nudges it off 'received' into the kitchen queue,
// and leaves paymentStatus 'pending' so the bill stays open until the cashier
// settles it. No-op once an order is already paid.
async function markPayLater(id, { organizationId } = {}) {
  const existing = await prisma.order.findUnique({ where: { id } })
  if (!existing) return null
  if (organizationId && existing.organizationId !== organizationId) return null
  if (existing.paymentStatus === 'paid') {
    const fresh = await prisma.order.findUnique({
      where: { id },
      include: { items: true, rating: true },
    })
    return toApiOrder(fresh)
  }
  // Push it into the kitchen queue if it's still sitting at 'received'.
  const nextStatus = existing.status === 'received' ? 'queued' : existing.status
  const updated = await prisma.order.update({
    where: { id },
    data: { payLater: true, status: nextStatus },
    include: { items: true, rating: true },
  })
  const api = toApiOrder(updated)
  realtime.emitOrderUpdate(api)
  // Kick off auto-progress (no-op when disabled) now that the gate is lifted.
  scheduleOrderProgress(api)
  return api
}

async function resumePendingOrders() {
  const cfg = await settings.getEtaConfig()
  if (!cfg.autoProgress) {
    console.log('Auto-advance disabled — pending orders await manual status updates.')
    return
  }
  const pending = await prisma.order.findMany({
    where: { status: { not: 'served' } },
  })
  for (const o of pending) {
    await scheduleOrderProgress(toApiOrder({ ...o, items: [], rating: null }))
  }
  if (pending.length) {
    console.log(`Resumed auto-progress for ${pending.length} pending order(s)`)
  }
}

module.exports = {
  STATUS_FLOW,
  createOrder,
  getOrder,
  listOrders,
  setOrderStatus,
  setPaymentMethod,
  markPaid,
  markPayLater,
  saveRating,
  resumePendingOrders,
  prisma,
}
