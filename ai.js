// Gemini-powered AI assistant.
//
// One thin wrapper around Google's Generative Language REST API (free tier —
// get a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY).
// No SDK: Node 20's built-in fetch is enough and keeps the dependency tree flat.
//
// Everything AI in the app funnels through generate():
//   • the customer-facing AI Waiter chat (recommendations, diet filters,
//     multilingual answers, combo suggestions)
//   • admin menu-description writing
//   • review summarisation for the dashboard
//   • friendly order summaries on the tracking page

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''
// Model fallback chain. "gemini-flash-latest" is Google's rolling alias for
// the current flash model, but on the free tier it regularly 503s under
// demand spikes — and pinned names (e.g. gemini-2.5-flash) get retired for
// new API keys. So we try each model in order and fall through on
// retryable errors (404 retired / 429 quota / 503 overloaded).
const MODEL_CHAIN = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []),
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
].filter((m, i, a) => a.indexOf(m) === i)

const endpointFor = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

// Remember which chain position last worked so every request doesn't re-pay
// the timeout/503 latency of the models above it. Reset after 5 minutes to
// drift back toward the preferred model once the spike passes.
let workingIdx = 0
let workingIdxAt = 0
function startIdx() {
  if (Date.now() - workingIdxAt > 5 * 60_000) workingIdx = 0
  return workingIdx
}

function enabled() {
  return Boolean(GEMINI_API_KEY)
}

class AiError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'AiError'
    this.status = status
  }
}

// ── Per-org rate limiting ───────────────────────────────────────────────
// The free Gemini tier allows a small number of requests/minute. A sliding
// window per organization keeps one busy (or abusive) tenant from burning
// the whole platform's quota. In-memory is fine — a restart just resets it.
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = Number(process.env.AI_RATE_LIMIT_PER_MIN || 15)
const hits = new Map() // orgId -> [timestamps]

function checkRateLimit(orgId) {
  const key = orgId || 'platform'
  const now = Date.now()
  const list = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS)
  if (list.length >= MAX_PER_WINDOW) {
    throw new AiError('The AI assistant is a little busy — please try again in a minute.', 429)
  }
  list.push(now)
  hits.set(key, list)
}

// ── Core call ───────────────────────────────────────────────────────────
// messages: [{ role: 'user' | 'assistant', text }]
// When json=true the model is forced to emit application/json and the parsed
// object is returned; otherwise the raw text is.
// Note: current flash models are "thinking" models whose reasoning tokens
// count against maxOutputTokens, so the cap needs generous headroom or the
// visible reply gets truncated (finishReason MAX_TOKENS → broken JSON).
async function generate({ system, messages, json = false, temperature = 0.6, maxOutputTokens = 4096 }) {
  if (!enabled()) {
    throw new AiError('AI is not configured. Set GEMINI_API_KEY on the server.', 503)
  }
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.text || '') }],
  }))
  const body = {
    ...(system ? { system_instruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  }

  let lastError = null
  for (let i = startIdx(); i < MODEL_CHAIN.length; i++) {
    const model = MODEL_CHAIN[i]
    let res
    try {
      res = await fetch(endpointFor(model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      // Network hiccup / timeout — try the next model before giving up.
      lastError = new AiError(`Could not reach the AI service: ${err.message}`)
      continue
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 404 = model retired for this key, 429 = per-model quota, 503 = demand
      // spike. All three are model-specific on the free tier — fall through.
      if ([404, 429, 503].includes(res.status)) {
        lastError =
          res.status === 429
            ? new AiError('The AI assistant hit its usage limit — please try again shortly.', 429)
            : new AiError(`AI request failed (${res.status}): ${detail.slice(0, 300)}`)
        continue
      }
      throw new AiError(`AI request failed (${res.status}): ${detail.slice(0, 300)}`)
    }

    const data = await res.json()
    // Skip thought parts (thinking models may return them) and keep only the
    // visible reply text.
    const text = (data.candidates?.[0]?.content?.parts || [])
      .filter((p) => !p.thought)
      .map((p) => p.text || '')
      .join('')
      .trim()

    // Empty or truncated output (usually the thinking budget eating the whole
    // token cap, finishReason MAX_TOKENS) is model-specific too — fall through
    // to the next model instead of failing the request.
    if (!text) {
      lastError = new AiError('The AI returned an empty response — please try again.')
      continue
    }
    let out = text
    if (json) {
      try {
        out = parseJson(text)
      } catch (err) {
        lastError = err
        continue
      }
    }

    // Only remember a model as "working" once it produced a usable response,
    // so a model that 200s with broken output doesn't get pinned.
    workingIdx = i
    workingIdxAt = Date.now()
    return out
  }
  throw lastError || new AiError('All AI models are unavailable right now — please try again shortly.')
}

// Gemini occasionally wraps JSON in markdown fences even in JSON mode.
function parseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // Last resort: grab the outermost object.
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
    throw new AiError('The AI response could not be parsed — please try again.')
  }
}

// ── Prompt builders ─────────────────────────────────────────────────────

const LOCALE_NAMES = { en: 'English', hi: 'Hindi', bn: 'Bengali' }

// Compact one-line-per-dish menu the model can ground every answer in.
function menuCatalogue(dishes, categories) {
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  return dishes
    .map((d) =>
      [
        `id=${d.id}`,
        `name=${d.name}`,
        `category=${catName.get(d.categoryId) || 'Other'}`,
        `price=₹${d.price}`,
        d.isVeg ? 'veg' : 'non-veg',
        `spice=${d.spice}/3`,
        d.available && !(d.trackStock && d.stock === 0) ? 'available' : 'SOLD OUT',
        d.tag ? `tag=${d.tag}` : '',
        Number.isFinite(d.gstRate) ? `gst=${d.gstRate}%` : '',
        d.description ? `desc=${d.description.slice(0, 120)}` : '',
      ]
        .filter(Boolean)
        .join(' | '),
    )
    .join('\n')
}

function waiterSystemPrompt({ org, dishes, categories, locale, context }) {
  const language = LOCALE_NAMES[locale] || locale || 'English'
  const location =
    context?.serviceType === 'takeaway'
      ? 'a takeaway order'
      : context?.serviceType === 'room'
        ? `Room ${context?.tableNo || ''}`
        : context?.tableNo
          ? `Table ${context.tableNo}`
          : 'the restaurant'
  const cartLines = (context?.cart || [])
    .map((c) => `- ${c.qty} × ${c.name} (₹${c.price} each)`)
    .join('\n')

  return `You are the friendly AI Waiter for "${org.name}", an Indian restaurant. The guest is ordering from ${location}.

STRICT RULES:
- Only ever recommend dishes that appear in the MENU below. Never invent dishes, prices, or offers.
- Never mention dish ids in your reply text — use dish names.
- If a dish is marked SOLD OUT, do not recommend it.
- Reply in ${language} (the guest's chosen language), unless the guest writes in a different language — then mirror theirs.
- Keep replies short and warm (2–4 sentences), like a helpful waiter. Use the currency symbol ${org.currencySymbol || '₹'}.
- You can help with: dish recommendations, diet-based suggestions, combo/meal ideas, explaining dishes and ingredients, order/cart summaries, and general restaurant questions (hours, payment, how ordering works).
- Diet guidance: veg = isVeg dishes. Vegan = veg dishes without dairy/paneer/ghee/cream/butter/curd (judge from the name/description; when unsure, say the kitchen can confirm). High-protein = paneer, dal, lentils, chicken, fish, eggs, soya.
- Jain requests are STRICT: never suggest a dish whose name or description mentions onion, garlic, potato, or other root vegetables (e.g. anything called "garlic naan" is NOT Jain). Only suggest veg dishes that appear free of these, remind the guest the kitchen can prepare many dishes Jain-style on request, and advise confirming with staff. If nothing clearly qualifies, say so honestly instead of guessing.
- For anything you cannot help with (refunds, complaints needing a human, allergies you're unsure about), politely suggest asking the restaurant staff.
- You take no actions — the guest adds dishes to their cart themselves. Suggest, don't pretend to order.

OUTPUT FORMAT — respond with ONLY this JSON object:
{"reply": "<your reply in ${language}>", "suggestedDishIds": ["<id of each dish you recommended, max 4, in the order mentioned>"]}
Use an empty array when you aren't recommending specific dishes.

RESTAURANT INFO:
- Name: ${org.name}${org.address ? `\n- Address: ${org.address}` : ''}${org.contactPhone ? `\n- Phone: ${org.contactPhone}` : ''}
- Tax: ${org.taxLabel || 'GST'} is added to the bill (default ${org.gstRate ?? 5}%; dishes marked gst=X% use their own rate).

MENU:
${menuCatalogue(dishes, categories)}
${cartLines ? `\nGUEST'S CURRENT CART:\n${cartLines}` : ''}`
}

function dishDescriptionPrompt({ name, category, isVeg, spice, tag, notes }) {
  return `Write an appetising menu description for this dish at an Indian restaurant.

Dish: ${name}
${category ? `Category: ${category}` : ''}
Type: ${isVeg ? 'vegetarian' : 'non-vegetarian'}
Spice level: ${spice ?? 1} out of 3
${tag ? `Tag: ${tag}` : ''}
${notes ? `Extra notes from the owner: ${notes}` : ''}

Rules: one or two sentences, maximum 30 words total, mouth-watering but honest, no emojis, no price, plain text only.`
}

function reviewSummaryPrompt(reviews) {
  const lines = reviews
    .map(
      (r) =>
        `- food ${r.food}/5, service ${r.service}/5, overall ${r.overall}/5${r.comments ? ` — "${r.comments.slice(0, 200)}"` : ''}`,
    )
    .join('\n')
  return `You are analysing customer reviews for a restaurant owner. Here are the latest reviews (newest first):

${lines}

Respond with ONLY this JSON object:
{"summary": "<2-3 sentence plain-English summary of what customers think>", "highlights": ["<up to 3 short things customers love>"], "improvements": ["<up to 3 short, actionable things to improve>"], "sentiment": "<positive|mixed|negative>"}`
}

function orderSummaryPrompt({ order, org, locale }) {
  const language = LOCALE_NAMES[locale] || locale || 'English'
  const items = (order.items || [])
    .map((it) => `- ${it.qty} × ${it.name} (₹${it.price} each)${it.instructions ? ` [note: ${it.instructions}]` : ''}`)
    .join('\n')
  return `Write a short, warm order confirmation summary in ${language} for a restaurant guest. 2 sentences max, no emojis beyond one at most, mention the total and the estimated wait. Plain text only.

Restaurant: ${org.name}
Items:
${items}
Total: ₹${order.amounts?.total ?? order.total} (includes ${org.taxLabel || 'GST'})
Estimated wait: about ${order.etaMinutes} minutes
Status: ${order.status}`
}

module.exports = {
  enabled,
  generate,
  checkRateLimit,
  AiError,
  waiterSystemPrompt,
  dishDescriptionPrompt,
  reviewSummaryPrompt,
  orderSummaryPrompt,
}
