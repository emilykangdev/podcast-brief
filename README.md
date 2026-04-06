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

**Enum `brief_status`:** `('pending', 'queued', 'generating', 'complete', 'error')`. Only `queued`, `generating`, and `complete` are used. `pending` and `error` are legacy/unused.

**Dedup rule:** At submission, block if a row with the same `input_url` + `profile_id` exists with `status='queued'` or `status='generating'` (return 409). Allow resubmission if the existing row is `complete`.

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
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase client
- `APP_ENV` — `DEVELOPMENT`, `STAGING`, or `PRODUCTION`. Written to `briefs.environment` at submission time.

### Railway (Worker)
- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY` — Supabase admin client
- `APP_ENV` — `DEVELOPMENT`, `STAGING`, or `PRODUCTION`. Must match Vercel's value for the corresponding environment. Worker only polls briefs where `environment = APP_ENV`.
- `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY`, `EXA_API_KEY` — pipeline APIs
- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` — headless browser
- `WEBHOOK_URL` — developer error alert endpoint (optional)

Note: Vercel and Railway share no secrets. They communicate only through Supabase.

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

## Plans

Implementation plans live in `tmp/done-plans/`. Each documents design decisions, edge cases, and implementation details for a feature.
