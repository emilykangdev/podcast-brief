# Arcjet Security MVP: Shield + Per-Route Rate Limiting & Bot Detection

## Goal

Add `@arcjet/next` to protect all API endpoints. Global `shield` in middleware for OWASP attack protection, plus per-route Arcjet instances with tailored rate limiting and bot detection on each of the 4 API routes. Add a 429 handler in the frontend `apiClient` so users see a friendly toast when rate-limited.

## Why

- Zero rate limiting or bot detection exists today — all 4 API routes are exposed
- `/api/jobs/brief` consumes credits and triggers an expensive Browserbase pipeline — abuse here costs real money
- `/api/auth/callback` is a classic brute-force target
- `/api/webhook/stripe` handles payment processing — replay floods could cause issues
- Security is critical even at MVP; the attack surface is small (4 routes) so this is tractable

## What

### User-visible behavior
- Abusive requests get blocked with appropriate HTTP status codes (403 for bots/shield, 429 for rate limits)
- Rate-limited users see a toast: "Slow down — please try again in a moment."
- Legitimate users see no change in behavior
- All rules are LIVE (blocking), not DRY_RUN

### Success Criteria

- [ ] `shield` runs on every request via middleware (including dashboard pages — intentional, low overhead)
- [ ] Each API route has its own Arcjet instance with appropriate rules
- [ ] Rate limit responses return 429 with `error` message
- [ ] Bot detection blocks on auth callback and brief creation routes
- [ ] Stripe webhook has rate limiting but no bot detection (Stripe servers are bots)
- [ ] Unauthenticated routes (webhook, auth callback) track by IP
- [ ] Authenticated routes (brief, estimate) track by userId
- [ ] `apiClient` shows a toast on 429 responses
- [ ] `apiClient` 403 message updated from "Pick a plan to use this feature" to "Bot detected"
- [ ] `npm run build` passes
- [ ] `ARCJET_KEY` in README.md env vars and `.env.example`

## All Needed Context

### Documentation & References

```yaml
- url: https://docs.arcjet.com
  why: Primary SDK reference for @arcjet/next

- file: middleware.js
  why: Existing Supabase session middleware — must chain Arcjet shield before it

- file: libs/api.js
  why: Frontend apiClient — add 429 handler here

- file: app/api/webhook/stripe/route.js
  why: Stripe webhook — rate limit only, no bot detection. Arcjet must run before req.text() on line 19.

- file: app/api/auth/callback/route.js
  why: Auth callback — rate limit + bot detection, per-IP

- file: app/api/jobs/brief/route.js
  why: Brief creation — most sensitive, rate limit + bot detection, per-userId

- file: app/api/jobs/brief/estimate/route.js
  why: Estimate endpoint — rate limit only, per-userId
```

### Known Gotchas & Library Quirks

```javascript
// CRITICAL: @arcjet/next shield in middleware must call aj.protect(request)
// and check decision.isDenied() BEFORE passing to Supabase updateSession().
// If denied, return a Response directly — don't call updateSession.

// CRITICAL: For the Stripe webhook, do NOT add detectBot() — Stripe's
// servers ARE bots. Only slidingWindow for flood protection.

// CRITICAL: tokenBucket (used on /api/jobs/brief) requires passing
// { requested: N } to aj.protect(). Unlike slidingWindow, token bucket
// needs to know how many tokens to consume:
//   aj.protect(req, { userId: user.id, requested: 1 })

// CRITICAL: The middleware.js is plain JS (not TypeScript). Use JS syntax.

// CRITICAL: ARCJET_KEY env var must be set. Without it, Arcjet throws at startup.

// CRITICAL: In the Stripe webhook route, aj.protect(req) must be called
// BEFORE req.text(). req.text() consumes the request body stream — once
// read, it's gone and can't be read again. Arcjet only reads headers, so
// calling aj.protect(req) first is safe and leaves the body stream
// untouched for req.text() to read normally. If you flip the order,
// the body is already consumed and webhook signature verification breaks.

// CRITICAL: For authenticated routes (brief, estimate), run auth check
// (getUser) first, then pass userId to aj.protect(). Unauthenticated
// requests return 401 before hitting rate limits — shield in middleware
// already catches the worst abuse on those.

// CRITICAL: characteristics key names must match exactly between the rule
// config and the aj.protect() call. If the rule has characteristics: ["userId"],
// then protect() must receive { userId: value }. A mismatch is a runtime error
// not caught at build time — validate with npm run build + manual test.

// IMPORTANT: Do NOT rewrite entire route handler functions. Each route already
// has existing logic (PostHog tracking, error handling, etc.). Only INSERT the
// Arcjet import, aj instance, and the protect/deny block at the specified
// insertion point. Leave all other code untouched.

// IMPORTANT: In the brief route (app/api/jobs/brief/route.js), the Arcjet
// denial block MUST be inside the existing try/catch wrapper. The POST handler
// wraps everything in try { ... } catch (e) { ... }. If the Arcjet block is
// placed outside the try, uncaught Arcjet errors will crash the route instead
// of returning a 500.

// IMPORTANT: NextResponse is already imported in all 4 route files. Do NOT
// add a duplicate import when adding the Arcjet imports.
```

### Current Codebase Tree

```bash
middleware.js                              # Supabase session renewal
libs/api.js                                # Frontend apiClient with interceptors
app/api/
  auth/callback/route.js                   # OAuth callback
  jobs/brief/route.js                      # Brief creation + regeneration
  jobs/brief/estimate/route.js             # Credit cost estimate
  webhook/stripe/route.js                  # Stripe webhook
```

### Desired Codebase Tree

```bash
middleware.js                              # ← MODIFIED: add Arcjet shield
libs/api.js                                # ← MODIFIED: add 429 handler
app/api/
  auth/callback/route.js                   # ← MODIFIED: add Arcjet rate limit + bot detection
  jobs/brief/route.js                      # ← MODIFIED: add Arcjet rate limit + bot detection
  jobs/brief/estimate/route.js             # ← MODIFIED: add Arcjet rate limit
  webhook/stripe/route.js                  # ← MODIFIED: add Arcjet rate limit
```

No new files. Each route imports `arcjet` directly from `@arcjet/next`.

## Architecture Overview

```
Request
  │
  ▼
middleware.js ─── shield({ mode: "LIVE" }) ─── block OWASP attacks globally
  │                                              (runs on all non-static routes
  │                                               including dashboard — intentional)
  │ (if allowed)
  ▼
Supabase updateSession() ─── refresh auth cookies
  │
  ▼
API Route handler
  │
  ▼
Per-route Arcjet ─── route-specific rules (rate limit, bot detection)
  │                   - webhook/callback: tracked by IP (unauthenticated)
  │                   - brief/estimate: tracked by userId (authenticated)
  │
  │ (if allowed)
  ▼
Business logic (existing code unchanged)
```

Two layers: middleware catches OWASP attacks on ALL routes, then individual API routes apply their own rate limits and bot detection with tailored thresholds.

## Implementation Blueprint

### Tasks (in implementation order)

```yaml
Task 1: Install @arcjet/next
  - npm install @arcjet/next

Task 2: MODIFY middleware.js — add global shield
  - Import arcjet + shield from @arcjet/next
  - Create aj instance with shield({ mode: "LIVE" })
  - Call aj.protect(request) BEFORE updateSession
  - If denied, return 403 Response (don't call updateSession)
  - If allowed, continue to updateSession as before
  - PRESERVE the existing export const config matcher block exactly as-is

Task 3: MODIFY app/api/webhook/stripe/route.js — rate limit only (per-IP)
  - Import arcjet + slidingWindow from @arcjet/next
  - Create aj instance: slidingWindow({ mode: "LIVE", interval: "1m", max: 50 })
  - Call aj.protect(req) BEFORE req.text() (line 19) — first thing in POST handler
  - If denied + isRateLimit, return 429 with error message
  - No detectBot (Stripe servers are bots)

Task 4: MODIFY app/api/auth/callback/route.js — rate limit + bot detection (per-IP)
  - Import arcjet + slidingWindow + detectBot from @arcjet/next
  - Create aj instance:
    - slidingWindow({ mode: "LIVE", interval: "10m", max: 10 })
    - detectBot({ mode: "LIVE", allow: [] })
  - Call aj.protect(req) at top of GET handler
  - If denied:
    - decision.reason.isBot() → return 403 with "Forbidden"
    - decision.reason.isRateLimit() → return 429 with error message

Task 5: MODIFY app/api/jobs/brief/route.js — rate limit + bot detection (per-userId)
  - Add arcjet imports at top of file (NextResponse is already imported — don't duplicate)
  - Create aj instance outside the handler
  - DO NOT rewrite the POST handler — only insert the Arcjet block
  - Insertion point: AFTER the auth check (line ~91), INSIDE the existing try/catch
  - Call aj.protect(req, { userId: user.id, requested: 1 })
  - If denied:
    - decision.reason.isBot() → return 403
    - decision.reason.isRateLimit() → return 429 with error message
  - Leave all existing code (PostHog tracking, regen logic, etc.) untouched

Task 6: MODIFY app/api/jobs/brief/estimate/route.js — rate limit only (per-userId)
  - Add arcjet imports at top of file (NextResponse is already imported — don't duplicate)
  - Create aj instance outside the handler
  - DO NOT rewrite the POST handler — only insert the Arcjet block
  - Insertion point: AFTER the auth check on line 10 (`if (!user) return ...`),
    BEFORE `req.json()` on line 12
  - Call aj.protect(req, { userId: user.id })
  - If denied + isRateLimit, return 429 with error message
  - Leave all existing code untouched

Task 7: MODIFY libs/api.js — add 429 + update 403 in response interceptor
  - Add a 429 case AFTER the 402 block, BEFORE the 403 block
  - 429 toast: "Slow down — please try again in a moment."
  - Change existing 403 message from "Pick a plan to use this feature" to "Bot detected"
  - Both cases return Promise.reject(error)

Task 8: Add ARCJET_KEY to env var documentation
  - Add to README.md under Vercel env vars section
  - Add ARCJET_KEY= to .env.example
```

### Per-Task Pseudocode

#### Task 2: middleware.js (full file)

```javascript
import arcjet, { shield } from "@arcjet/next";
import { updateSession } from "@/libs/supabase/middleware";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [shield({ mode: "LIVE" })],
});

export async function middleware(request) {
  const decision = await aj.protect(request);
  if (decision.isDenied()) {
    return new Response("Forbidden", { status: 403 });
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
```

#### Task 3: Stripe webhook (per-IP, rate limit only)

```javascript
// Add at top of file, after existing imports:
import arcjet, { slidingWindow } from "@arcjet/next";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    slidingWindow({ mode: "LIVE", interval: "1m", max: 50 }),
  ],
});

// Insert at very start of POST handler, BEFORE req.text():
export async function POST(req) {
  const decision = await aj.protect(req);
  if (decision.isDenied()) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429 }
    );
  }

  // ... existing code from line 9 onward unchanged ...
}
```

#### Task 4: Auth callback (per-IP, rate limit + bot detection)

```javascript
import arcjet, { slidingWindow, detectBot } from "@arcjet/next";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    slidingWindow({ mode: "LIVE", interval: "10m", max: 10 }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

export async function GET(req) {
  const decision = await aj.protect(req);
  if (decision.isDenied()) {
    if (decision.reason.isBot()) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // ... existing code unchanged ...
}
```

#### Task 5: Brief creation (per-userId, token bucket + bot detection)

```javascript
// ADD these imports at top of file (NextResponse already imported — don't duplicate):
import arcjet, { tokenBucket, detectBot } from "@arcjet/next";

// ADD this aj instance OUTSIDE the handler, after imports:
const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    tokenBucket({
      mode: "LIVE",
      refillRate: 2,
      interval: 60,
      capacity: 10,
      characteristics: ["userId"],
    }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

// INSERT this block INSIDE the existing POST handler's try block,
// AFTER the auth check (~line 91), BEFORE the regen/new-brief logic.
// Do NOT rewrite the function — all surrounding code stays as-is.

    // Rate limit AFTER auth — tracked per user, not per IP
    const decision = await aj.protect(req, { userId: user.id, requested: 1 });
    if (decision.isDenied()) {
      if (decision.reason.isBot()) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return NextResponse.json(
        { error: "Too many requests. Please try again shortly." },
        { status: 429 }
      );
    }
```

#### Task 6: Estimate (per-userId, sliding window)

```javascript
// ADD these imports at top of file (NextResponse already imported — don't duplicate):
import arcjet, { slidingWindow } from "@arcjet/next";

// ADD this aj instance OUTSIDE the handler, after imports:
const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    slidingWindow({
      mode: "LIVE",
      interval: "1m",
      max: 30,
      characteristics: ["userId"],
    }),
  ],
});

// INSERT this block INSIDE the POST handler,
// AFTER the auth check on line 10, BEFORE req.json() on line 12.
// Do NOT rewrite the function — all surrounding code stays as-is.

  // Rate limit AFTER auth — tracked per user
  const decision = await aj.protect(req, { userId: user.id });
  if (decision.isDenied()) {
    return NextResponse.json(
      { error: "Too many requests. Please try again shortly." },
      { status: 429 }
    );
  }
```

#### Task 7: apiClient 429 handler + 403 update

```javascript
// In libs/api.js, insert 429 case AFTER the 402 block, BEFORE the 403 block.
// Also update the 403 message.

    } else if (error.response?.status === 429) {
      toast.error("Slow down — please try again in a moment.");
      return Promise.reject(error);
    } else if (error.response?.status === 403) {
      message = "Bot detected";  // was: "Pick a plan to use this feature"
```

### Rate Limit Thresholds Summary

| Route | Algorithm | Limit | Track By | Bot Detection |
|-------|-----------|-------|----------|---------------|
| middleware (all) | shield | — | — | — |
| `/api/webhook/stripe` | slidingWindow | 50/min | IP | No |
| `/api/auth/callback` | slidingWindow | 10/10min | IP | Yes (allow: []) |
| `/api/jobs/brief` | tokenBucket | capacity 10, refill 2/min | userId | Yes (allow: []) |
| `/api/jobs/brief/estimate` | slidingWindow | 30/min | userId | No |

## Validation Loop

```bash
# After each task:
npm run build              # Next.js build — catches import errors, missing env
npm run lint               # ESLint
```

## Final Validation Checklist

- [ ] `npm run build` passes
- [ ] `npm run lint` passes
- [ ] middleware.js has shield protection before updateSession
- [ ] middleware.js preserves existing `export const config` matcher
- [ ] All 4 API routes have Arcjet protection
- [ ] Webhook + callback use per-IP tracking (default)
- [ ] Brief + estimate use per-userId tracking (characteristics + userId param)
- [ ] Brief route passes `{ requested: 1 }` to aj.protect (tokenBucket requirement)
- [ ] Stripe webhook does NOT have detectBot
- [ ] Stripe webhook Arcjet runs BEFORE req.text()
- [ ] All modes are "LIVE"
- [ ] apiClient handles 429 with a friendly toast
- [ ] ARCJET_KEY in README.md env vars and .env.example
- [ ] No existing behavior changed — Arcjet is additive only

## Anti-Patterns to Avoid

- Don't add Arcjet to dashboard page routes beyond the global shield (decided in brief)
- Don't use DRY_RUN (decided in brief — go LIVE for MVP)
- Don't add detectBot to Stripe webhook (Stripe servers are bots)
- Don't create a shared `libs/arcjet.js` wrapper — each route imports `arcjet` directly from `@arcjet/next`
- Don't modify existing business logic — Arcjet protection is purely additive
- Don't forget that middleware.js is JavaScript, not TypeScript
- Don't call aj.protect() before auth on the brief/estimate routes — userId tracking requires the user ID

## Deprecated Code

None. This plan is purely additive — no existing code is removed or replaced.
