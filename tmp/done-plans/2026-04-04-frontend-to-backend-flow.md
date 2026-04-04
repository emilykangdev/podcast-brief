# Plan: Frontend-to-Backend Flow (Staging)

## Goal

Confirm the full end-to-end flow works on staging: user signs in via magic link on Vercel preview, submits a podcast URL on the dashboard, and the Railway worker generates a brief. Check the result directly in the Supabase `briefs` table.

## Context

### Already resolved
- Magic link redirects fixed via Supabase Auth URL Configuration (Site URL + Redirect URLs allowlist)
- `app/api/jobs/brief/route.js` already proxies to `${WORKER_URL}/jobs/brief` with `Bearer ${WORKER_SECRET}` — no code changes needed
- `server.mjs` auth middleware already validates Bearer token — no code changes needed
- Vercel preview has WORKER_URL set pointing to Railway staging (`https://podcast-brief-staging.up.railway.app`)

### Problems to fix
1. **WORKER_SECRET is not set in Railway staging** — auth middleware checks against `undefined`, every request gets 401
2. **Dashboard has no URL input** — `app/dashboard/page.js` is nearly empty (just heading + ButtonAccount)

### Out of scope
- Brief list/viewer UI — check Supabase table directly
- Separate Supabase projects for staging/prod — one project is fine (no customers yet)
- Any changes to the API route or worker server

## What

### Step 1: Set WORKER_SECRET in Railway staging

Use Railway MCP or dashboard to set `WORKER_SECRET` on the `podcast-brief` service in the `staging` environment. Value must match what's set in Vercel preview.

### Step 2: Add URL input form to dashboard

#### Design decision: server page + extracted client component (Option B)

Two approaches were considered:

**Option A — `"use client"` on the whole page:**
- Pros: simpler, one file, no component extraction needed
- Cons: the entire page and its import tree ships as client JS even for static content (heading, layout). Loses the ability to `async/await` data directly in the page (e.g., fetching briefs later). Next.js docs explicitly recommend pushing `"use client"` to leaf nodes, not page-level.

**Option B — Keep page as server component, extract form into a client component:**
- Pros: static parts (heading, layout, ButtonAccount) stay server-rendered with zero JS overhead. The page can `async/await` data directly, which sets us up for adding brief listing later without refactoring. This is the pattern Next.js App Router was designed around.
- Cons: one extra file, need to think about the server/client boundary for props.

**Decision: Option B.** The dashboard is mostly static with one interactive island (the URL form). Extracting the form keeps the page aligned with Next.js best practices and avoids shipping unnecessary JS. One extra file is a trivial cost.

#### Implementation

**New file:** `components/BriefRequestForm.js`
- `"use client"` directive
- Same URL input + submit pattern from `app/onboarding/page.js`:
  - `useState` for url, loading, error, submitted
  - Submit button calling `POST /api/jobs/brief` with `{ episodeUrl }`
  - Loading, error, and success states

**Modified file:** `app/dashboard/page.js`
- Keep as server component (no `"use client"`)
- Keep `export const dynamic = "force-dynamic"` and `ButtonAccount`
- Import and render `BriefRequestForm`

### Step 3: Fix URL sanitization

#### Problem
`WORKER_URL` set with a trailing slash (`https://...railway.app/`) caused double slashes in the fetch URL (`https://...railway.app//jobs/brief`), which Express doesn't match — returning 404. Same risk exists for `WEBHOOK_URL`.

#### Fix
- **New file:** `libs/url.js` — exports `cleanUrl(envVarName)` which reads the env var and strips trailing slashes
- **Modified:** `app/api/jobs/brief/route.js` — uses `cleanUrl("WORKER_URL")` instead of raw `process.env.WORKER_URL`
- **Modified:** `server.mjs` — uses `cleanUrl("WEBHOOK_URL")` instead of raw `process.env.WEBHOOK_URL`

Any future URL env var used to build fetch URLs should use `cleanUrl()` to prevent this class of bug.

### Step 4: Fix Railway networking port mismatch

#### Problem
Railway's public networking was routing to port 3000, but the server listens on port 8080 (injected via `PORT` env var). All external requests got `"Application failed to respond"` (502).

#### Fix
Changed Railway public networking port from 3000 to 8080 in the Railway dashboard (Settings → Networking → Public Networking).

### Step 5: Test on Vercel preview (done)

- Push this branch, wait for Vercel preview deployment
- Sign in via magic link on the preview URL
- Submit a podcast URL on the dashboard
- Check Supabase `briefs` table for the generated brief
- Load-tested with 5 concurrent briefs — all completed

### Step 6: Supabase-backed job queue (one-at-a-time processing)

#### Problem
Browserbase free tier allows only 1 concurrent session. When multiple briefs are submitted simultaneously, the pipeline fails with `429 max concurrent sessions limit`. The current code fires `runPipeline()` immediately for every request with no concurrency control.

#### Design decision: Supabase as the queue (not in-memory)

**Option A — In-memory queue (JS array + drain loop):**
- Pros: minimal code, event-driven (no polling), lower latency
- Cons: lost on crash/redeploy, two sources of truth (array vs Supabase), no visibility into queue state, doesn't scale to multiple workers

**Option B — Supabase as the queue:**
- Pros: single source of truth, crash-proof (queued rows survive restarts), full visibility (`SELECT * FROM briefs WHERE status='queued'`), scales to multiple workers, matches existing design where Supabase owns brief lifecycle
- Cons: slightly more code, poll interval adds ~5s latency (irrelevant for multi-minute pipelines), brief row creation moves earlier in the flow

**Decision: Option B.** Don't maintain state in two places when one will do. Supabase already has the rows and the status field.

#### Brief lifecycle: `queued → generating → complete`

Today the `brief_status` enum is `('pending', 'generating', 'complete', 'error')`. This step adds `'queued'` to the enum. Note: `'error'` is unused — the pipeline always reaches `'complete'` (with `error_log` on failure). `'pending'` is also unused.

**Status transitions:**
1. **`queued`** — row created at submission time (in the API route), before any pipeline work starts. `started_at=NULL`. Stores `input_url` as the raw Apple Podcasts URL (not the transcriptId — that's derived later during transcription).
2. **`generating`** — worker claims the row and begins processing. Set atomically: `UPDATE briefs SET status='generating', started_at=now() WHERE id=<id> AND status='queued' RETURNING *` — if 0 rows returned, silently skip and poll again (another worker claimed it during blue-green deploy overlap). "Started" means the worker claimed it — NOT when the user submitted it.
3. **`complete`** — pipeline finished (success or failure). Always reached, even on catastrophic failure. On failure, `error_log` is populated but the user still gets whatever output was produced.

**`started_at` semantics:** Written ONLY when the worker claims the row (transition to `generating`). `NULL` while `queued`. Used ONLY for startup recovery — the worker never checks "is my current job taking too long" mid-run. If the process is alive, the catch block handles any failure. `started_at` only matters when a new worker instance boots and needs to distinguish a crashed job from a still-active blue-green job.

**Intermediate `output_markdown` write:** `generate-brief.mjs` writes `output_markdown` to the existing row mid-pipeline (after step 2, while still `generating`). This is crash insurance — if steps 3-5 (reference enrichment) fail, the user still gets a brief without reference links. One extra Supabase write per job. Status stays `generating` during this write; only `server.mjs` sets `complete`.

**Dedup rule:** At row creation time, check if a row with the same `input_url` + `profile_id` exists with `status='queued'` or `status='generating'`. If so, return `409 Conflict` with `{ error: "A brief for this episode is already in progress" }`. If the existing row is `complete` (success or failure), allow resubmission — the user gets a fresh brief. A "regenerate" feature is out of scope.

**Bonus fix:** Under the current code, if `transcribe()` throws before `generate-brief.mjs` runs, `briefId` is still `null` and the catch block can't update any Supabase row — the failure is silent. With the queued row created at submission time, `briefId` is always known, so the catch block can always mark the brief `complete` with `error_log`. This fixes a pre-existing silent failure bug.

**Edge cases and safeguards:**

| Scenario | What happens | Recovery |
|----------|-------------|----------|
| Worker crashes mid-generation | Row stuck at `generating` | On startup, reset stale rows: `UPDATE briefs SET status='queued' WHERE status='generating' AND started_at < NOW() - INTERVAL '20 minutes'` (staleness guard prevents resetting a still-active job during blue-green deploy overlap) |
| Worker crashes between claim and `generating` | Narrow window; row stays `queued` | Self-healing — next poll picks it up |
| Pipeline throws unrecoverably | Catch block sets `complete` + `error_log` | Already handled — `briefId` is always known now |
| Duplicate submission (same episode URL) | Dedup check at row creation time | Block if `queued` or `generating`; allow if `complete` |
| Worker redeploys (Railway blue-green) | Old and new instance could both poll | Atomic claim UPDATE prevents double-processing; startup reset uses staleness guard |
| Row stays `queued` while worker is down | Sits in queue | Self-healing — worker boots, polls, picks it up |

#### Implementation

**Supabase migration:**
- `ALTER TYPE public.brief_status ADD VALUE 'queued'`
- Add `started_at timestamptz` column to `briefs` table
- Add `environment text NOT NULL DEFAULT 'PRODUCTION'` column to `briefs` table
- Add composite index on `(status, environment, created_at)` for the poll query

**Environment isolation (staging vs production):**
One Supabase project, one briefs table, but two Railway workers (staging + prod) poll the same table. Without filtering, prod could steal a staging job or vice versa.
- API route sets `environment` from `process.env.APP_ENV` at row creation time
- Railway worker filters all queries with `AND environment = process.env.APP_ENV`
- This applies to: the poll query, the atomic claim, and the startup recovery reset
- `APP_ENV` values are uppercase: `DEVELOPMENT`, `STAGING`, `PRODUCTION`
- `APP_ENV` env var: Vercel preview = `'STAGING'`, Vercel production = `'PRODUCTION'`, Railway staging = `'STAGING'`, Railway production = `'PRODUCTION'`, local dev = `'DEVELOPMENT'`

**New file: `libs/supabase/admin.js`**
- Exports a single Supabase admin client using `SUPABASE_URL` + `SUPABASE_SECRET_KEY`
- Used by `server.mjs` and all pipeline scripts (`generate-brief.mjs`, `transcribe.mjs`, etc.)
- Replaces the multiple independent `createClient()` calls scattered across scripts — single pattern, per the reusability principle
- `libs/supabase/server.js` remains separate (it's the Next.js cookie-based client, different by necessity)

**Modified: `app/api/jobs/brief/route.js`**
- **No longer calls Railway.** The API route's only job is to write to Supabase and return.
- Remove `fetch` to `WORKER_URL`, remove `cleanUrl("WORKER_URL")` import
- `WORKER_URL` and `WORKER_SECRET` are no longer needed as Vercel env vars
- Create the brief row with `status='queued'` and `input_url=episodeUrl` at submission time
- Return `{ status: "queued", briefId }` to the client (for future polling if needed)
- Dedup: check for existing `queued`/`generating` row with same `input_url` + `profile_id`. Return 409 with `{ error: "A brief for this episode is already in progress" }`.
- Uses `libs/supabase/server.js` (cookie-based client) since it needs the user's auth context

**Modified: `server.mjs`**
- **No longer receives HTTP requests from Vercel.** The `POST /jobs/brief` endpoint, auth middleware, and `WORKER_SECRET` check are all removed. Railway discovers work by polling Supabase.
- Remove: in-memory queue (jobQueue array, enqueue, drain), `POST /jobs/brief` handler, auth middleware
- Remove: `WORKER_SECRET` env var dependency (Railway no longer needs it)
- Keep: `/status` health check endpoint (useful for monitoring, no auth needed)
- Import Supabase client from `libs/supabase/admin.js` instead of creating its own
- Add poll loop: every 5 seconds, query `SELECT * FROM briefs WHERE status='queued' ORDER BY created_at ASC LIMIT 1`
- Also trigger a poll immediately after each job completes (don't wait for next interval tick)
- Claim with atomic UPDATE; if 0 rows returned, silently skip
- On startup: reset stale `generating` rows where `started_at < NOW() - INTERVAL '20 minutes'` back to `queued`
- `runPipeline` receives `briefId` and `episodeUrl` from the claimed row — no longer depends on `generate-brief.mjs` to create the row
- Remove `BriefExistsError` import (dead code after dedup moves to API route)

**Modified: `scripts/generate-brief.mjs`**
- Accept `briefId` parameter instead of creating a new row
- Remove `resolveExistingBrief()`, `BriefExistsError`, and the Supabase insert — dedup is now handled by the API route
- Keep the intermediate UPDATE that writes `output_markdown` mid-pipeline (line 218) — this lets us preserve partial output if later steps fail. It receives `briefId` from the queued row.
- Import Supabase client from `libs/supabase/admin.js` instead of creating its own

**Modified: `scripts/transcribe.mjs`**
- Import Supabase client from `libs/supabase/admin.js` instead of creating its own

**Modified: `libs/url.js`**
- `cleanUrl` should throw `Error("Missing required env var: <name>")` instead of returning `""` when the env var is not set. An empty string causes a confusing `TypeError: Failed to parse URL` downstream.
- Note: `cleanUrl("WORKER_URL")` call in `route.js` is removed entirely (no more Railway proxy). `cleanUrl("WEBHOOK_URL")` in `server.mjs` stays.

**Env var cleanup:**
- Remove from Vercel preview/production: `WORKER_URL`, `WORKER_SECRET`
- Remove from Railway: `WORKER_SECRET`
- Vercel and Railway no longer need any shared secret — they communicate only through Supabase

### Step 7: Test queue behavior on staging

- Submit 3+ briefs rapidly
- Verify they process one at a time (check Railway logs for sequential execution)
- Kill the Railway service mid-pipeline, verify recovery on restart
- Check Supabase for correct status transitions

### Rating

TBD — not yet implemented