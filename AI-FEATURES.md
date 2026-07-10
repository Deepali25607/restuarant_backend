# AI Assistant (Google Gemini)

All AI features run through the free Gemini API. One env var turns everything on:

```
# resto-backend/.env
GEMINI_API_KEY=your-key-here          # free key: https://aistudio.google.com/apikey
# GEMINI_MODEL=gemini-2.5-flash       # optional override
# AI_RATE_LIMIT_PER_MIN=15            # optional per-org cap (protects free-tier quota)
```

No key → every AI surface hides itself automatically (the frontend checks
`GET /api/ai/status` first). No other configuration needed.

## What it does

| Feature | Where | Endpoint |
| --- | --- | --- |
| 🤖 AI Waiter chatbot — recommendations, dish questions, customer support | Floating ✨ button on customer pages (menu, cart, tracking) | `POST /api/ai/chat` |
| 🥗 Diet suggestions (Veg, Vegan, Jain, High-protein) + 🍽️ combo ideas | Quick chips inside the chat | same |
| 🌐 Multilingual replies (English, हिन्दी, বাংলা — mirrors the guest's language) | Chat follows the language picker | same |
| 📞 Voice input | Mic button in the chat (browser Web Speech API) | — |
| 📝 AI menu descriptions | Admin → Menu → dish editor → "Write with AI" | `POST /api/ai/describe-dish` |
| ⭐ Review summarization | Admin → Dashboard → "What customers are saying" card | `GET /api/ai/review-summary` |
| 🧾 Order summary generation | Customer tracking page, in the guest's language | `GET /api/ai/order-summary/:orderId` |

## Guardrails

- The chat is grounded in the tenant's live menu — it only recommends real,
  in-stock dishes (the backend re-validates every suggested dish id) and is
  instructed to never invent prices or offers.
- Per-org sliding-window rate limit (default 15 req/min) so one tenant can't
  burn the platform's free-tier quota; review summaries are cached 10 minutes.
- Customer endpoints use the same `x-organization-id` header contract as the
  menu; admin endpoints sit behind the normal permission middleware
  (`menu.manage`, `dashboard.view`).
