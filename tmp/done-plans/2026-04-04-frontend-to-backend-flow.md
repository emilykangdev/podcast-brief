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

### Step 5: Test on Vercel preview

- Push this branch, wait for Vercel preview deployment
- Sign in via magic link on the preview URL
- Submit a podcast URL on the dashboard
- Check Supabase `briefs` table for the generated brief

### Rating 

10/10

Quizzed with Claude