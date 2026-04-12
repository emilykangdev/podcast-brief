# Brief: Arcjet Security MVP

## Why
The app has zero rate limiting or bot detection on any endpoint. There are 4 API routes that handle auth, payments, and credit-consuming operations — all currently unprotected beyond Supabase JWT and Stripe HMAC. Security is critical even at MVP stage.

## Context

### Current endpoints and their existing protection:
- `POST /api/webhook/stripe` (`app/api/webhook/stripe/route.js`) — Stripe HMAC signature verification only
- `GET /api/auth/callback` (`app/api/auth/callback/route.js`) — Supabase code exchange only
- `POST /api/jobs/brief` (`app/api/jobs/brief/route.js`) — JWT auth + HMAC-signed estimate
- `GET /api/jobs/brief/estimate` (`app/api/jobs/brief/estimate/route.js`) — JWT auth only

### Global middleware:
- `middleware.js` at project root — currently only handles Supabase session renewal via `updateSession()`

### Framework:
- Next.js App Router (serverless API routes under `/app/api/`)

### Arcjet SDK (`@arcjet/next`):
Available primitives:
- **`shield()`** — OWASP Top 10 attack protection (SQLi, XSS, etc.)
- **`detectBot()`** — Bot detection with allowlist; `allow: []` blocks all bots
- **`slidingWindow()`** — Rate limiting (sliding window algorithm)
- **`fixedWindow()`** — Rate limiting (fixed window algorithm)
- **`tokenBucket()`** — Rate limiting (token bucket — good for bursty traffic)
- **`validateEmail()`** — Not needed (Supabase OAuth, no email/password signup)
- **`sensitiveInfo()`** — Not needed (no user-submitted free text with PII)
- **`protectSignup()`** — Not needed (no signup form)

All rules support `mode: "LIVE"` (block) or `mode: "DRY_RUN"` (log only, lets request through). Go LIVE on everything for MVP.

## Decisions

- **Shield globally in middleware** — `shield({ mode: "LIVE" })` in `middleware.js`. Low overhead, catches OWASP attacks across all routes. No reason not to have this everywhere.
- **Per-route Arcjet instances for API routes** — Each API route gets its own `arcjet` instance with tailored rules. Only 4 routes, so this is not over-engineered. Rules genuinely differ per route (webhook needs no bot detection, brief creation needs tighter limits than estimate).
- **Skip dashboard page protection** — Dashboard pages are server-rendered, already behind Supabase auth, don't mutate data or consume credits. Global `shield` in middleware already covers OWASP attacks on these routes. Low value at MVP.
- **All rules in LIVE mode** — No DRY_RUN. MVP doesn't have enough traffic to warrant an observation period. Can flip to DRY_RUN if false positives appear.

### Per-route plan:

1. **`middleware.js`** — Add `shield({ mode: "LIVE" })` globally
2. **`POST /api/webhook/stripe`** — `slidingWindow` only. Stripe's servers are bots, so no `detectBot`. Rate limit to prevent replay/flood (e.g., `interval: "1m", max: 50`).
3. **`GET /api/auth/callback`** — `slidingWindow` + `detectBot`. Auth callback abuse is a brute-force vector. Tight rate limit (e.g., `interval: "10m", max: 10`). Block all bots with `allow: []`.
4. **`POST /api/jobs/brief`** — `slidingWindow` or `tokenBucket` + `detectBot`. Most sensitive endpoint (consumes credits, triggers expensive Browserbase pipeline). Tight per-IP limit. Token bucket could work well for bursty usage patterns.
5. **`GET /api/jobs/brief/estimate`** — `slidingWindow` only. Less sensitive, light rate limit (e.g., `max: 30, window: "1m"`). Bot detection optional/skip.

## Rejected Alternatives

- **validateEmail / sensitiveInfo / protectSignup** — Not applicable. Auth is Supabase OAuth, no email/password forms, no user-submitted PII text.
- **Dashboard page route protection** — Server-rendered, behind auth, no mutations or credit consumption. Not worth the added complexity at MVP.
- **DRY_RUN first** — Not enough traffic at MVP to justify an observation period. LIVE from day one.
- **Single global rate limit in middleware** — Too coarse. Different endpoints have genuinely different threat models and appropriate thresholds.

## Direction
Add `@arcjet/next` with `shield` globally in middleware and per-route Arcjet instances on all 4 API routes. Each route gets tailored rate limiting (sliding window or token bucket) and bot detection where appropriate. All rules in LIVE mode. Skip dashboard page protection.
