# Podcast Brief

Generates structured briefs from podcast episodes. Users submit an Apple Podcasts URL, and the system transcribes, summarizes, enriches references, and delivers a formatted brief.

## Architecture

```
Browser (Vercel)
  │ POST /api/jobs/brief { episodeUrl }
  ▼
app/api/jobs/brief/route.js     ← Next.js API route (server-side)
  │ authenticates user via Supabase
  │ creates brief row with status="queued"
  │ returns { status: "queued", briefId }
  │ (does NOT call Railway — no direct communication)
  ▼
Supabase (briefs table)          ← single source of truth
  │ status lifecycle: queued → generating → complete
  ▲                          │
  │ polls every 5s           │ writes status + output
  │                          ▼
server.mjs on Railway            ← persistent Express server
  │ claims queued row, sets status="generating"
  │ runs 5-step pipeline sequentially
  │ sets status="complete" with output
  ▼
User checks dashboard / receives email (email TBD)
```

**Key design decision:** Vercel and Railway never talk to each other directly. Supabase is the only communication channel. This means:
- If Railway is down, user submissions are still saved (just wait in queue)
- If Vercel is down, Railway keeps processing existing queue
- No shared secrets between Vercel and Railway
- Supabase API requests are unlimited and free on all plans

## Authentication Flow (Magic Link)

Uses Supabase Auth with email OTP (magic links) + PKCE for secure code exchange.

```
1. User enters email on /signin, clicks "Send Magic Link"
   │
2. Browser: supabase.auth.signInWithOtp({ email, emailRedirectTo })
   │  └─ Supabase JS client generates a PKCE code verifier
   │     and stores it in a browser cookie (sb-<ref>-auth-token-code-verifier)
   │
3. Supabase server receives request
   │  └─ Generates a one-time token
   │  └─ Constructs verification URL:
   │     https://<ref>.supabase.co/auth/v1/verify?token=<token>&type=magiclink&redirect_to=<emailRedirectTo>
   │  └─ This URL is what {{ .ConfirmationURL }} resolves to in the email template
   │
4. Supabase sends email via Resend (configured email provider)
   │  └─ New user → "Confirm Signup" template
   │  └─ Existing user → "Magic Link" template
   │  └─ Both use {{ .ConfirmationURL }}, both generate the same verification URL
   │
5. User clicks link in email
   │  └─ Hits Supabase's /auth/v1/verify endpoint
   │  └─ Supabase verifies the token
   │  └─ Redirects to: <emailRedirectTo>?code=<auth_code>
   │
6. Browser arrives at /api/auth/callback?code=...
   │  └─ exchangeCodeForSession(code) reads the PKCE code verifier
   │     from the cookie set in step 2 and sends both to Supabase
   │  └─ Supabase returns session tokens → cookies are set
   │
7. Callback checks if user has briefs
   └─ No briefs → redirect to /onboarding
   └─ Has briefs → redirect to /dashboard
```

**Email templates** are configured in the Supabase dashboard (Authentication → Email Templates), not in code.

**PKCE cookie requirement**: The code verifier cookie from step 2 must be present when step 6 runs. If the user opens the magic link in a **different browser** or the cookie was cleared, `exchangeCodeForSession` silently fails — no session, user bounces back to sign-in. This is the #1 cause of magic link login failures.

**Redirect URL allowlist**: `emailRedirectTo` must match a pattern in Supabase → Authentication → URL Configuration → Redirect URLs. If it doesn't match, Supabase silently falls back to the Site URL, which may be a different domain — causing a cookie domain mismatch.

## Brief Lifecycle

| Status | Meaning |
|--------|---------|
| `queued` | Row created at submission. `created_at` records when the user submitted. `started_at` is `NULL`. Waiting for worker to pick it up. |
| `generating` | Worker claimed this row and is actively running the pipeline. `started_at` records when processing began (not when the user submitted). |
| `complete` | Pipeline finished. Always reached, even on failure. `completed_at` records when it finished. Check `error_log` for issues. |

**Invariant:** A brief never stays stuck. The pipeline catch block always sets `complete`. On worker crash, startup recovery resets stale `generating` rows (where `started_at` is older than 20 minutes) back to `queued`.

## Supabase: `briefs` Table

| Column | Type | Set when | Description |
|--------|------|----------|-------------|
| `id` | uuid | `queued` | Primary key, generated at row creation |
| `profile_id` | uuid | `queued` | The user who submitted the request |
| `input_url` | text | `queued` | Raw Apple Podcasts episode URL as submitted by the user |
| `status` | `brief_status` enum | transitions | `queued` → `generating` → `complete` |
| `created_at` | timestamptz | `queued` | When the user submitted the request. This is queue entry time — not when processing started. |
| `started_at` | timestamptz | `generating` | When the worker claimed the row and began pipeline execution. `NULL` while queued. The difference `started_at - created_at` = time spent waiting in queue. |
| `completed_at` | timestamptz | `complete` | When the pipeline finished (success or failure). The difference `completed_at - started_at` = pipeline execution time. |
| `output_markdown` | text | `generating` (partial), `complete` (final) | Brief content. Written mid-pipeline after step 2 (crash insurance — partial output preserved if later steps fail). Overwritten with final merged output at completion. |
| `references` | jsonb | `complete` | Validated reference links. `NULL` if reference enrichment failed or was skipped. |
| `error_log` | jsonb | `complete` (if degraded) | `NULL` on clean runs. Populated with structured error context when the pipeline retried, partially failed, or hit an unrecoverable error. Query degraded briefs: `SELECT * FROM briefs WHERE error_log IS NOT NULL`. |
| `environment` | text | `queued` | `DEVELOPMENT`, `STAGING`, or `PRODUCTION`. Set from `APP_ENV` env var at submission time. Workers filter all queries by this column to prevent cross-contamination. One Supabase project, one table, isolated by environment. |
| `podcast_name` | text | `generating` | Podcast name from Apple iTunes API. Written by the worker after the transcribe step. Used for dashboard display and zip folder names. |
| `episode_title` | text | `generating` | Episode title from Apple iTunes API. Written by the worker after the transcribe step. Used for dashboard display and zip filenames. |
| `regeneration_count` | integer | `queued` (on regen) | Default 0. Set to 1 when the user triggers a regeneration. Each brief gets one free regen — the button disappears after. |
| `episode_duration_seconds` | integer | `queued` | Duration of the podcast episode in seconds. Set by the `consume_credits_and_queue_brief` RPC at submission time. Used to compute credit cost (1 credit per audio hour, rounded up). |
| `credits_charged` | integer | `queued` | Number of credits deducted for this brief. Set by the RPC. `NULL` for pre-credit briefs (created before the credit system). Used by the regen cost calculation and dashboard display. |

**Enum `brief_status`:** `('pending', 'queued', 'generating', 'complete', 'error')`. Only `queued`, `generating`, and `complete` are used. `pending` and `error` are legacy/unused.

**Dedup rule:** At submission, block if **any** row with the same `input_url` + `profile_id` + `environment` exists (return 409), regardless of status. Users who want a new run for a completed brief must use the regenerate button. The `handleRegenerate` path only blocks `queued`/`generating` (not `complete`) because it needs the completed row to exist in order to reset it.

**Regeneration:** Users can regenerate a completed brief once. Free within 24 hours of completion (quality guarantee); full price (same credits as original) after 24h. Pre-credit briefs (`credits_charged` NULL) are always free to regen. The `consume_credits_and_regenerate_brief` RPC handles credit deduction + atomic row reset in one transaction.

## Credit System

**1 credit = 1 hour of audio (rounded up).** A 30min episode costs 1 credit; a 2h15min episode costs 3.

### Pricing tiers
| Pack | Price | Per credit |
|------|-------|------------|
| 5 credits | $6 | $1.20 |
| 15 credits | $15 | $1.00 |
| 50 credits | $40 | $0.80 |

New users get **3 free credits** on signup.

### Brief submission flow (two-step with HMAC anti-tamper)
```
1. POST /api/jobs/brief/estimate { episodeUrl }
   → resolves episode via iTunes API → gets durationSeconds
   → creditsNeeded = Math.ceil(durationSeconds / 3600)
   → checks: >4h cap? insufficient credits?
   → signs HMAC(episodeUrl|durationSeconds) with STRIPE_SECRET_KEY
   → returns { durationSeconds, creditsNeeded, creditsRemaining, episodeTitle, sig }

2. POST /api/jobs/brief { episodeUrl, durationSeconds, sig }
   → validates durationSeconds: integer, > 0, ≤ 4h
   → verifies HMAC sig matches (episodeUrl + durationSeconds) — rejects if tampered
   → calls consume_credits_and_queue_brief() Postgres RPC
   → atomically: dedup check → credit check → deduct → insert brief → write ledger
   → returns { briefId, creditsCharged, creditsRemaining }
```

**Why the signature?** Without it, a malicious client could skip the estimate endpoint and POST directly to `/api/jobs/brief` with `durationSeconds: 1` to pay only 1 credit for a 4-hour episode. The HMAC ties the `durationSeconds` value to the server's authoritative iTunes lookup. The secret key never leaves the server — the frontend just passes the `sig` back unchanged, like a receipt stamp. If the sig doesn't match, the request is rejected with 422.

### Idempotent webhook crediting
The Stripe webhook uses an **insert-first pattern**: it attempts to INSERT a `credit_ledger` row with the Stripe `event.id` as `stripe_event_id` (which has a unique partial index). If the insert succeeds, this is the first delivery → `increment_credits` RPC runs. If it fails with 23505 (duplicate), the event was already processed → skip. If `increment_credits` fails, the ledger row is rolled back and the webhook returns 503 so Stripe retries.

### Cost per episode
| Action | Credits | When |
|--------|---------|------|
| New brief | N credits (1 per audio hour, rounded up) | Always |
| Regen within 24h | 0 credits | Quality guarantee |
| Regen after 24h | N credits (same as original) | Full price |
| Pre-credit brief regen | 0 credits | Always free |

### 4-hour episode cap
Episodes longer than 4 hours are rejected at the estimate endpoint with a friendly message. This stays within Deepgram's synchronous processing window. When demand for longer episodes appears, the async Deepgram callback plan can be shipped to raise the cap.

## Checkout Routes

- **`GET /checkout?priceId=xxx&mode=payment`** — Stripe Embedded Checkout form. Auth-guarded (redirects to `/signin` if not logged in). Renders Stripe's payment form inside an iframe on our domain. After payment, Stripe redirects to the return page.
- **`GET /checkout/return?session_id=xxx`** — Post-payment status page. Auth-guarded. Verifies session ownership (`client_reference_id === user.id`). Shows success (with credits purchased), failure, or generic error. Links to dashboard.

## Dashboard

The dashboard (`/dashboard`) is a server component that fetches briefs from Supabase and passes them to a client component (`DashboardClient`).

**Features:**
- **Brief list** — cards showing episode title, podcast name, status badge, and date. Newest first. In-progress briefs are muted (opacity-50) with "Queued" or "Generating" badges.
- **Auto-polling** — refreshes every 60s while any brief is in-progress. Stops when all are complete.
- **Brief modal** — click a card to view the full brief rendered as markdown. Includes copy-to-clipboard (raw markdown) and regenerate button.
- **Download All** — zips all completed briefs as `.md` files organized into folders by podcast name. Client-side via JSZip.

**New dependencies:** `react-markdown`, `remark-gfm`, `jszip`, `@tailwindcss/typography`

## Pipeline Steps (server.mjs)

1. **Transcribe** — Deepgram transcription via Browserbase browser session
2. **Generate brief** — LLM summarization via OpenRouter
3. **Enrich references** — Exa search to find URLs for entities mentioned in the episode
4. **Validate references** — Browserbase browser session to verify URLs are live
5. **Merge references** — Combine validated reference links back into the brief markdown

## Key Constraints

- **Browserbase free tier: 1 concurrent session.** Pipeline jobs are queued and processed one at a time.
- **Supabase is the queue.** No in-memory state. Worker polls for `status='queued'` rows.
- **Pipeline always completes.** Failed briefs get `status='complete'` with `error_log` populated. Users are never left hanging.

## Infrastructure

| Service | Purpose | URL pattern |
|---------|---------|-------------|
| Vercel | Next.js frontend + API routes | `podcast-brief.vercel.app` |
| Railway | Worker server (pipeline execution) | `podcast-brief-staging.up.railway.app` |
| Supabase | Auth, database, brief storage | `whojufsiiwhermzgnhlo.supabase.co` |
| Browserbase | Headless browser for transcription + reference validation | — |
| Deepgram | Audio transcription | — |
| OpenRouter | LLM API (brief generation) | — |
| Exa | Search API (reference enrichment) | — |

## Env Vars

### Vercel (Next.js)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase client (browser-safe)
- `SUPABASE_SECRET_KEY` — Supabase admin/service-role client (server-only, never exposed to browser)
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — Stripe publishable key (browser-safe, for embedded checkout form)
- `STRIPE_SECRET_KEY` — Stripe secret key (server-only, for creating checkout sessions)
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret (server-only, for verifying webhook payloads)
- `APP_ENV` — `DEVELOPMENT`, `STAGING`, or `PRODUCTION`. Written to `briefs.environment` at submission time.

### Railway (Worker)
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` — Supabase admin client
- `APP_ENV` — `DEVELOPMENT`, `STAGING`, or `PRODUCTION`. Must match Vercel's value for the corresponding environment. Worker only polls briefs where `environment = APP_ENV`.
- `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY`, `EXA_API_KEY` — pipeline APIs
- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` — headless browser
- `WEBHOOK_URL` — developer error alert endpoint (optional)

Note: Vercel and Railway both use `SUPABASE_SECRET_KEY` but for different purposes — Vercel for API route credit RPCs, Railway for worker brief processing. They still communicate only through Supabase (no direct HTTP calls between them).

## Supabase Client Pattern (Split-Client)

API routes use two Supabase clients with distinct roles:

| Client | Import | Purpose | Permissions |
|--------|--------|---------|-------------|
| `authSupabase` | `libs/supabase/server` | Cookie-backed. **Only** used for `auth.getUser()` to identify the caller. | User's own RLS scope |
| `db` (admin) | `libs/supabase/admin.mjs` | Service-role. Used for all reads/writes after binding to `user.id`. | Bypasses RLS, can call service-role-only RPCs |

**Why two clients?** Credit RPCs (`consume_credits_and_queue_brief`, `consume_credits_and_regenerate_brief`, `increment_credits`) are locked to `service_role` only — `REVOKE EXECUTE FROM PUBLIC, authenticated` in the migration. This prevents browser-side clients from calling them directly to bypass business rules (e.g., passing `p_credits_to_charge=0` for a paid brief). The API route validates inputs and enforces rules before calling the RPC through the admin client.

### Why the admin client is safe in a Next.js app on Vercel

The admin client uses `SUPABASE_SECRET_KEY` (the service-role key), which has full database access with no RLS restrictions. This sounds dangerous but is safe here because of how Next.js and Vercel work:

1. **The key never reaches the browser.** `SUPABASE_SECRET_KEY` has no `NEXT_PUBLIC_` prefix. Vercel only bundles env vars prefixed with `NEXT_PUBLIC_` into client-side JavaScript. The secret key exists only in the Node.js serverless function process.
2. **API routes are server-side only.** Files under `app/api/` run as serverless functions on Vercel's infrastructure, not in the browser. The admin client is imported and used exclusively in these server-side routes.
3. **Every query is scoped to the authenticated user.** The admin client bypasses RLS, but every query includes `.eq("profile_id", user.id)` where `user.id` comes from the cookie-backed auth client. The elevated permissions don't mean "access all users" — they mean "access this user's data without RLS filtering overhead, and call service-role-only RPCs."
4. **RPCs are locked down at the SQL level.** All credit RPCs have `REVOKE EXECUTE FROM PUBLIC, authenticated` — even if someone discovered the secret key, calling the RPCs through a browser Supabase client with the anon key would fail with "permission denied." Only the service-role key works.
5. **The key was already on Vercel.** The webhook route (`app/api/webhook/stripe/route.js`) already imports `libs/supabase/admin.mjs` and has been deployed to Vercel since the initial Stripe integration. No new env var exposure.

**Pattern in code** (see `app/api/jobs/brief/route.js`):
```javascript
const authSupabase = await createClient();          // cookie-backed
const { data: { user } } = await authSupabase.auth.getUser();
const db = adminSupabase;                           // service-role
// All queries below use db.from("briefs").eq("profile_id", user.id)...
```

## URL Env Var Convention

Always use `cleanUrl("VAR_NAME")` from `libs/url.js` when building fetch URLs from env vars. This strips trailing slashes and prevents double-slash routing bugs.

## Running Scripts (CLI)

Each pipeline script works as both a module (imported by `server.mjs`) and a standalone CLI tool via a shim at the bottom. The CLI interface is unchanged from before the module refactor.

```bash
# 1. Transcribe
node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"

# 2. Generate brief
node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> <transcript.md> <profileId> [--force]

# 3. Enrich references (find URLs for entities)
node --env-file=.env.local scripts/enrich-references.mjs <brief-output.md>

# 4. Validate references (check URLs are live via Browserbase)
node --env-file=.env.local scripts/validate-references.mjs <references.json>

# 5. Merge references (combine validated links into brief)
node --env-file=.env.local scripts/merge-references.mjs <brief-output.md> <validated-references.md>
```

## Error Handling: End-to-End

Every brief always reaches `status='complete'`. There is no `error` status. The `error_log` column (jsonb, nullable) is the single source of truth for what went wrong.

### Dashboard badge logic

The badge is based on whether the user has a readable brief — not on internal pipeline errors.

| `output_markdown` | `status` | Dashboard badge |
|---|---|---|
| has content | `complete` | Green **"Complete"** |
| `null` | `complete` | Red **"Failed"** |
| any | `generating` | Yellow **"Generating"** |
| any | `queued` | Blue **"Queued"** |

`error_log` is **developer-only** — check it in Supabase to diagnose pipeline issues. It is never shown to users. A brief with content is "Complete" even if the pipeline retried, reference validation failed, or Browserbase 429'd. The user has their brief; that's what matters.

### What `error_log` means (developer reference)

- **`step: "validate-output"`** — LLM retry. The LLM missed sections or references on the first try, the pipeline retried with a targeted prompt, and recovered. Normal pipeline behavior.
- **`step: "unrecoverable"`** — Something actually broke. Deepgram timed out, Browserbase returned 429, LLM errored, etc. Check if the brief still has content — if yes, the user is unaffected.

### Pipeline error flow (step by step)

```
1. TRANSCRIBE (Deepgram)
   ✓ → continue to step 2
   ✗ → catch block: completeBrief(briefId, { errorLog })
        output_markdown stays null (never written)
        error_log: [{ step: "unrecoverable", error: "..." }]

2. GENERATE BRIEF (OpenRouter LLM)
   ✓ → validate output (briefHasAllSections + briefHasReferences)
   ✗ → catch block: same as above

   2a. VALIDATE OUTPUT
       All sections present + has references → continue to step 3
       Missing sections or 0 references →
         errorLog.push({ step: "validate-output", attempt: 1 })
         RETRY once with targeted prompt addition
         Still failing after retry →
           errorLog.push({ step: "validate-output", attempt: 2 })
           Patch "## REFERENCES\nNo references found." into markdown
           Continue to step 3 (degraded)

   Note: output_markdown is written to Supabase mid-pipeline here
   (crash insurance — if steps 3-5 fail, user still gets a brief
   without validated reference links)

3. ENRICH REFERENCES (Exa search)
   ✓ → returns referencesJsonPath (candidates per reference)
   ✗ or null → skip steps 4-5, complete with unmerged brief

4. VALIDATE REFERENCES (Browserbase)
   ✓ → returns validated URLs
   ✗ → skip step 5, complete with unmerged brief

5. MERGE REFERENCES
   ✓ → final brief with validated links
   ✗ → catch block: complete with whatever output exists
```

### Cost per episode (worst case)

| Call | Credits | When |
|------|---------|------|
| User submits episode | 1 credit | Always |
| Worker internal retry (validation failure) | 0 credits | Only if LLM output fails validation (missing sections or 0 references). Max 1 retry. |
| User clicks regenerate | 0 credits | Optional. One free regen per brief. Entire pipeline re-runs. |

Worst case: 3 LLM calls (original + 1 internal retry + 1 user regen) for 1 credit. The internal retry is invisible to the user.

### `error_log` structure

The `error_log` column is a jsonb array. Each entry has a `step` field and context-specific fields:

```jsonc
// Validation retry (degraded but recovered)
{ "step": "validate-output", "attempt": 1, "reasons": ["Missing sections: REFERENCES"] }
{ "step": "validate-output", "attempt": 2, "reason": "No references found in REFERENCES section" }

// Unrecoverable crash
{ "step": "unrecoverable", "error": "Deepgram API timeout", "stack": "..." }
```

### Key invariants

- **A brief never stays stuck.** The catch block in `runPipeline()` always calls `completeBrief()`. On worker crash, periodic recovery (every 5 min) resets `generating` rows older than `STALE_JOB_TIMEOUT_MS` (currently 20 min) back to `queued`.
- **Stale job timeout must exceed max pipeline duration.** If a legit job takes longer than `STALE_JOB_TIMEOUT_MS` (20 min, `server.mjs:17`), recovery could reset it to `queued` while it's still running. This is safe: there's only one worker per environment, and `isProcessing` prevents it from picking up the re-queued row. When the original run finishes, `completeBrief` overwrites the status back to `complete`. No double processing. The 20-minute threshold has wide margin over the typical 2-5 minute pipeline. If long episodes (3h+) start hitting this, increase the timeout.
- **`output_markdown` can exist while `status='generating'`.** Written mid-pipeline as crash insurance. The dashboard shows it with a "Generating" badge.
- **Badge = has content, not error_log.** Green "Complete" if `output_markdown` exists, red "Failed" if null. `error_log` is developer-only (check Supabase). A brief with content is always "Complete" to the user, even if the pipeline had internal retries or Browserbase failures.
- **Regeneration preserves old content.** The regeneration reset does NOT clear `output_markdown`. If the new pipeline fails, the user still has their original brief.
- **`completeBrief()` only overwrites non-null fields.** On the error path, `output_markdown` is not passed, so whatever was written mid-pipeline (or the preserved original from regeneration) is kept.

## Plans

Implementation plans live in `tmp/done-plans/`. Each documents design decisions, edge cases, and implementation details for a feature.
