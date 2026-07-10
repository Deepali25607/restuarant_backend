// "Ask your data" — the AI business analyst behind /api/ai/insights.
//
// Safety model: the LLM never touches the database. We pre-aggregate an
// org-scoped snapshot with Prisma (revenue windows, daily series, dish
// rankings, expenses, ratings, loyalty) and hand it to Gemini as context, so
// answers are grounded, tenant-isolated by construction, and one API call per
// question. The snapshot is cached per org for a few minutes — dashboards get
// asked several questions in a row and the numbers barely move.

const { prisma } = require('./db')

// Calendar day (YYYY-MM-DD) in the org's timezone, so "today" matches the
// restaurant's clock, not the server's. Same approach as store.dayKeyFor.
function dayKey(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function weekdayOf(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Asia/Kolkata', weekday: 'short' }).format(date)
  } catch {
    return 'n/a'
  }
}

function hourOf(date, timeZone) {
  try {
    return Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timeZone || 'Asia/Kolkata', hour: 'numeric', hour12: false }).format(date),
    )
  } catch {
    return date.getHours()
  }
}

const DAY_MS = 86400000

async function buildSnapshot(organizationId) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } })
  const tz = org?.timezone || 'Asia/Kolkata'
  const now = new Date()
  // A full year of history: enough for "compare this quarter to last" and
  // seasonal questions, while the monthly series keeps the prompt compact.
  const since = new Date(now.getTime() - 365 * DAY_MS)

  const [orders, expenses, ratings, dishes, loyalty, tableCount, roomCount] = await Promise.all([
    prisma.order.findMany({
      where: { organizationId, createdAt: { gte: since } },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.expense.findMany({ where: { organizationId, date: { gte: since } } }),
    prisma.rating.findMany({
      where: { order: { organizationId }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.dish.findMany({ where: { organizationId } }),
    prisma.loyaltyMember.findMany({
      where: { organizationId },
      orderBy: { totalSpent: 'desc' },
      take: 5,
    }),
    prisma.table.count({ where: { organizationId } }),
    prisma.room.count({ where: { organizationId } }),
  ])

  const served = orders.filter((o) => o.status === 'served')
  const todayKey = dayKey(now, tz)
  const yesterdayKey = dayKey(new Date(now.getTime() - DAY_MS), tz)

  // Revenue windows over served orders (the same rule the Reports page uses).
  const windowStats = (days) => {
    const cutoff = new Date(now.getTime() - days * DAY_MS)
    const rows = served.filter((o) => o.createdAt >= cutoff)
    const revenue = rows.reduce((s, o) => s + (o.total || 0), 0)
    return { revenue, orders: rows.length, avgOrderValue: rows.length ? Math.round(revenue / rows.length) : 0 }
  }
  const dayStats = (key) => {
    const rows = served.filter((o) => dayKey(o.createdAt, tz) === key)
    return { revenue: rows.reduce((s, o) => s + (o.total || 0), 0), orders: rows.length }
  }

  // Daily series, last 30 days — one compact line per day.
  const daily = []
  for (let i = 29; i >= 0; i--) {
    const key = dayKey(new Date(now.getTime() - i * DAY_MS), tz)
    const s = dayStats(key)
    daily.push(`${key}: ₹${s.revenue} / ${s.orders} orders`)
  }

  // Monthly series (last 12 months) — the compact backbone for long-range
  // trend questions. Month keys in the org's timezone.
  const monthKey = (d) => dayKey(d, tz).slice(0, 7)
  const monthly = new Map()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15)
    monthly.set(monthKey(d), { revenue: 0, orders: 0 })
  }
  served.forEach((o) => {
    const row = monthly.get(monthKey(o.createdAt))
    if (row) {
      row.revenue += o.total || 0
      row.orders += 1
    }
  })
  const expByMonth = new Map([...monthly.keys()].map((k) => [k, 0]))
  expenses.forEach((e) => {
    if (expByMonth.has(monthKey(e.date))) expByMonth.set(monthKey(e.date), expByMonth.get(monthKey(e.date)) + e.amount)
  })
  const monthlyLines = [...monthly.entries()].map(
    ([k, s]) => `${k}: revenue ₹${s.revenue} / ${s.orders} orders, expenses ₹${expByMonth.get(k) || 0}`,
  )

  // Weekday + hour patterns over the recent 90 days — recent enough to
  // reflect current operating patterns.
  const cutoff90 = new Date(now.getTime() - 90 * DAY_MS)
  const recent = served.filter((o) => o.createdAt >= cutoff90)
  const byWeekday = {}
  const byHour = {}
  recent.forEach((o) => {
    const wd = weekdayOf(o.createdAt, tz)
    byWeekday[wd] = byWeekday[wd] || { orders: 0, revenue: 0 }
    byWeekday[wd].orders += 1
    byWeekday[wd].revenue += o.total || 0
    const h = hourOf(o.createdAt, tz)
    byHour[h] = (byHour[h] || 0) + 1
  })

  // Dish rankings (30d) including dishes that never sold.
  const cutoff30 = new Date(now.getTime() - 30 * DAY_MS)
  const dishSales = new Map(dishes.map((d) => [d.name, { qty: 0, revenue: 0 }]))
  served
    .filter((o) => o.createdAt >= cutoff30)
    .forEach((o) =>
      o.items.forEach((it) => {
        const row = dishSales.get(it.name) || { qty: 0, revenue: 0 }
        row.qty += it.qty
        row.revenue += it.qty * it.price
        dishSales.set(it.name, row)
      }),
    )
  const ranked = [...dishSales.entries()].sort((a, b) => b[1].qty - a[1].qty)
  const topDishes = ranked.slice(0, 12).map(([n, s]) => `${n}: ${s.qty} sold, ₹${s.revenue}`)
  const slowDishes = ranked
    .slice(-8)
    .filter(([, s]) => s.qty <= (ranked[Math.floor(ranked.length / 2)]?.[1].qty ?? 0))
    .map(([n, s]) => `${n}: ${s.qty} sold`)

  // Channel + settlement mix (30d).
  const svcMix = { table: { orders: 0, revenue: 0 }, room: { orders: 0, revenue: 0 }, takeaway: { orders: 0, revenue: 0 } }
  const payMix = {}
  served
    .filter((o) => o.createdAt >= cutoff30)
    .forEach((o) => {
      const svc = svcMix[o.serviceType] ? o.serviceType : 'table'
      svcMix[svc].orders += 1
      svcMix[svc].revenue += o.total || 0
    })
  orders
    .filter((o) => o.paymentStatus === 'paid' && o.createdAt >= cutoff30)
    .forEach((o) => {
      const m = o.paymentMethod || 'counter'
      payMix[m] = payMix[m] || { count: 0, amount: 0 }
      payMix[m].count += 1
      payMix[m].amount += o.total || 0
    })
  const unpaidOpen = orders.filter((o) => o.paymentStatus !== 'paid').length

  // Expenses & profit.
  const exp30 = expenses.filter((e) => e.date >= cutoff30)
  const expenseTotal30 = exp30.reduce((s, e) => s + e.amount, 0)
  const expByCategory = exp30.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + e.amount
    return acc
  }, {})
  const last30 = windowStats(30)

  // Ratings & comments.
  const avg = (key) =>
    ratings.length ? Math.round((ratings.reduce((s, r) => s + (r[key] || 0), 0) / ratings.length) * 10) / 10 : 0
  const recentComments = ratings
    .filter((r) => r.comments)
    .slice(0, 8)
    .map((r) => `[${r.overall}/5] ${r.comments.slice(0, 140)}`)

  const soldOut = dishes.filter((d) => !d.available || (d.trackStock && d.stock === 0))

  return `BUSINESS DATA SNAPSHOT for ${org?.name || 'the restaurant'} (generated ${now.toISOString()}, timezone ${tz}, currency ₹, all revenue figures are from served orders and include tax)

REVENUE WINDOWS:
- Today (${todayKey}): ₹${dayStats(todayKey).revenue} / ${dayStats(todayKey).orders} orders
- Yesterday (${yesterdayKey}): ₹${dayStats(yesterdayKey).revenue} / ${dayStats(yesterdayKey).orders} orders
- Last 7 days: ₹${windowStats(7).revenue} / ${windowStats(7).orders} orders (avg order ₹${windowStats(7).avgOrderValue})
- Last 30 days: ₹${last30.revenue} / ${last30.orders} orders (avg order ₹${last30.avgOrderValue})
- Last 90 days: ₹${windowStats(90).revenue} / ${windowStats(90).orders} orders
- Last 12 months: ₹${windowStats(365).revenue} / ${windowStats(365).orders} orders

DAILY (last 30 days):
${daily.join('\n')}

MONTHLY (last 12 months):
${monthlyLines.join('\n')}

BY WEEKDAY (90d): ${Object.entries(byWeekday).map(([d, s]) => `${d} ₹${s.revenue}/${s.orders}`).join(', ') || 'no data'}
BY HOUR of day, order counts (90d): ${Object.entries(byHour).sort((a, b) => a[0] - b[0]).map(([h, c]) => `${h}:00→${c}`).join(', ') || 'no data'}

TOP DISHES (30d): ${topDishes.length ? '\n' + topDishes.join('\n') : 'no sales yet'}
SLOWEST DISHES (30d, includes never-sold): ${slowDishes.length ? '\n' + slowDishes.join('\n') : 'n/a'}
MENU: ${dishes.length} dishes, ${soldOut.length} currently unavailable/sold out${soldOut.length ? ` (${soldOut.slice(0, 6).map((d) => d.name).join(', ')})` : ''}

CHANNELS (30d): dine-in ₹${svcMix.table.revenue}/${svcMix.table.orders} orders, room service ₹${svcMix.room.revenue}/${svcMix.room.orders}, takeaway ₹${svcMix.takeaway.revenue}/${svcMix.takeaway.orders}
PAYMENTS COLLECTED (30d): ${Object.entries(payMix).map(([m, s]) => `${m} ₹${s.amount} (${s.count})`).join(', ') || 'none'}
OPEN UNPAID ORDERS right now: ${unpaidOpen}

EXPENSES (last 30d): total ₹${expenseTotal30}${Object.keys(expByCategory).length ? ' — ' + Object.entries(expByCategory).map(([c, a]) => `${c} ₹${a}`).join(', ') : ''}
PROFIT (last 30d): revenue ₹${last30.revenue} − expenses ₹${expenseTotal30} = ₹${last30.revenue - expenseTotal30}

RATINGS (12mo): ${ratings.length} reviews — food ${avg('food')}/5, service ${avg('service')}/5, overall ${avg('overall')}/5
RECENT REVIEW COMMENTS: ${recentComments.length ? '\n' + recentComments.join('\n') : 'none'}

LOYALTY: top members by spend: ${loyalty.length ? loyalty.map((m) => `${m.name || m.phone} ₹${m.totalSpent} (${m.visits} visits, ${m.points} pts)`).join('; ') : 'no members yet'}
CAPACITY: ${tableCount} tables, ${roomCount} rooms`
}

// Snapshot cache: questions come in bursts, data moves slowly.
const cache = new Map() // orgId -> { at, text }
const CACHE_MS = 5 * 60_000

async function snapshotFor(organizationId) {
  const hit = cache.get(organizationId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.text
  const text = await buildSnapshot(organizationId)
  cache.set(organizationId, { at: Date.now(), text })
  return text
}

function analystSystemPrompt(snapshot) {
  return `You are a sharp, friendly business analyst for a restaurant owner. Answer their questions using ONLY the data snapshot below.

RULES:
- Ground every number in the snapshot. Never invent or extrapolate figures that aren't derivable from it.
- Derived math (sums, averages, percentages, comparisons, trends) over snapshot numbers is encouraged — show your working briefly when helpful.
- If the snapshot cannot answer the question (e.g. it needs data older than 12 months or per-customer detail), say so plainly and answer what you CAN.
- Currency is ₹. Keep answers short and owner-friendly: lead with the number/insight, then 1-2 sentences of context or advice.
- When a small table makes the answer clearer (rankings, comparisons, breakdowns), include one — max 8 rows.

OUTPUT FORMAT — respond with ONLY this JSON object:
{"answer": "<your answer>", "table": {"title": "<short title>", "columns": ["..."], "rows": [["..."]]} | null, "followups": ["<up to 3 short follow-up questions the owner might ask next>"]}

${snapshot}`
}

module.exports = { snapshotFor, analystSystemPrompt }
