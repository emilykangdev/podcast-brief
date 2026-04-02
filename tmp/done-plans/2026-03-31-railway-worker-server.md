# Plan: Railway Worker Server for On-Demand Brief Generation

## Goal

Deploy a persistent Node.js Express server on Railway that orchestrates the full 5-step brief pipeline when a user submits an Apple Podcasts URL. The Next.js app on Vercel calls a local API route, which proxies to the Railway worker. The worker fires and forgets — the pipeline always produces a result (never leaves the user hanging).

> **See also:**
> - `2026-03-31-email-delivery.md` — email notification via Resend + Supabase edge function (triggers when this server sets `status="complete"`)
> - `2026-03-31-dashboard.md` — dashboard markdown rendering + feedback mechanism

## Why

- The pipeline scripts (`transcribe`, `generate-brief`, `enrich-references`, `validate-references`, `merge-references`) currently run manually from the CLI — there's no way for users to trigger them
- Vercel is serverless/ephemeral and can't run a multi-minute pipeline job
- Railway provides a persistent Node.js process on existing infra ($5.66/mo already paid)
- The onboarding page has a disabled "Generate Brief" button waiting to be wired up

## What

### Success Criteria

- [ ] `POST /jobs/brief` on Railway accepts `{ episodeUrl, profileId }` with Bearer token auth, fires the full pipeline, returns `{ status: "queued" }` immediately
- [ ] All 5 scripts export a `run()` function AND work as CLI scripts via a shim at the bottom
- [ ] Next.js API route at `app/api/jobs/brief/route.js` proxies to Railway, gets profileId from Supabase session
- [ ] Onboarding page "Generate Brief" button is wired up and calls the Next.js API route
- [ ] `railway.toml` in repo root points Railway at `server.mjs` instead of `next start`
- [ ] Supabase `briefs` row is updated with the final merged output after all 5 steps complete
- [ ] Output validation (validate_pipeline.mjs) runs after step 2 and catches missing sections / missing references — retries `generateBrief` once with a context-specific prompt addition before accepting
- [ ] `validate-references.mjs` recovers from Browserbase session death by spinning up a new session and resuming from the failed reference (one retry max)
- [ ] Pipeline always produces a brief — never leaves `status="generating"` permanently. Degraded output is acceptable; errors are logged to `briefs.error_log` (jsonb) and a webhook notification is sent to the developer
- [ ] DB migration adds `error_log` jsonb column to `briefs` table
- [ ] Onboarding page shows "Your brief is being generated" after submit (email + dashboard handled in separate plans)

---

## All Needed Context

### Documentation & References

```yaml
- url: https://github.com/railwayapp/docs/blob/main/content/docs/config-as-code/reference.md
  why: railway.toml startCommand syntax — use [deploy] startCommand = "node server.mjs"

- url: https://github.com/railwayapp/docs/blob/main/content/docs/deployments/start-command.md
  why: Railway injects PORT env var; server must listen on process.env.PORT

- file: scripts/transcribe.mjs
  why: Understand existing structure before refactoring to module

- file: scripts/generate-brief.mjs
  why: Has 409 check, stale row detection, Supabase status lifecycle — preserve all of it

- file: scripts/enrich-references.mjs
  why: Understand output file path derivation (stem.replace(/-output.*$/, ""))

- file: scripts/validate-references.mjs
  why: Output path derived from dirname of input — works with absolute paths already

- file: scripts/merge-references.mjs
  why: Understand final file write pattern

- file: app/onboarding/page.js
  why: Has disabled Generate Brief button that needs to be wired up
```

### Current Codebase Tree

```
scripts/
  transcribe.mjs            # top-level await, process.exit() throughout
  generate-brief.mjs        # top-level await, process.exit() throughout
  enrich-references.mjs     # top-level await, process.exit() throughout
  validate-references.mjs   # top-level await, process.exit() throughout
  merge-references.mjs      # top-level await, process.exit() throughout
  validate_pipeline.mjs     # pure validation functions for each pipeline step — no side effects
app/
  onboarding/
    page.js                 # disabled Generate Brief button
  api/
    auth/callback/route.js
    stripe/...
package.json                # "start": "next start" — conflicts with Railway
.env.example                # missing WORKER_SECRET, WORKER_URL
```

### Desired Codebase Tree

```
scripts/
  transcribe.mjs            ← MODIFIED: export run() + CLI shim
  generate-brief.mjs        ← MODIFIED: export run() + CLI shim
  enrich-references.mjs     ← MODIFIED: export run() + CLI shim
  validate-references.mjs   ← MODIFIED: export run() + CLI shim
  merge-references.mjs      ← MODIFIED: export run() + CLI shim
  validate_pipeline.mjs     ← NEW: pure validation functions for each pipeline step
server.mjs                  ← NEW: Express worker server (orchestrator + retry logic + error_log writes + webhook alerts)
railway.toml                ← NEW: Railway deployment config
app/
  onboarding/
    page.js                 ← MODIFIED: wire up Generate Brief button
  api/
    jobs/
      brief/
        route.js            ← NEW: Next.js proxy route to Railway worker
package.json                ← MODIFIED: add express dependency
.env.example                ← MODIFIED: add WORKER_SECRET, WORKER_URL, WEBHOOK_URL
```

### Known Gotchas & Library Quirks

```js
// CRITICAL: Railway injects PORT env var. Server MUST listen on process.env.PORT.
// Hardcoding a port will cause Railway health checks to fail.
const PORT = process.env.PORT || 3001;

// CRITICAL: Scripts use top-level await at module scope — this is ESM only.
// When refactoring, the top-level await must move inside the run() function.
// The CLI shim must detect if it's the entry point:
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(...).catch((err) => { console.error(err.message); process.exit(1); });
}

// CRITICAL: scripts use process.cwd()/briefs for file output.
// In the server context, use os.tmpdir()/<jobId>/ instead.
// Pass outputDir to each run() function.

// CRITICAL: validate-references.mjs derives output path from dirname(resolve(inputPath)).
// This already works with absolute paths — no change needed there.

// CRITICAL: WORKER_SECRET must NOT be in NEXT_PUBLIC_ env vars.
// The Next.js API route (server-side) reads it; the browser never sees it.

// CRITICAL: generate-brief.mjs must NOT set status="complete" in the refactored run().
// Keep status="generating" so the frontend doesn't show the un-merged brief early.
// Only server.mjs sets status="complete" after Step 5 finishes.

// CRITICAL: generate-brief.mjs has process.stdout.write(disclaimer + brief) — REMOVE this
// inside run(). It was for CLI piping; in a server context it dumps the full brief to stdout.

// CRITICAL: generate-brief.mjs hardcodes "briefs" dir in mkdirSync and existsSync.
// Use outputDir directly (not path.join(outputDir, "briefs")) — consistent with other scripts.

// CRITICAL: enrich-references.mjs returns null when no refs found (2 early-exit paths).
// server.mjs must null-check referencesJsonPath. If null, this means the brief has no
// REFERENCES section — server.mjs should RETRY generateBrief once with a prompt addition
// (see validate_pipeline.mjs and retry logic below). If the retry also produces no references,
// inject a placeholder "## References\n\nNo references found." section and proceed.

// CRITICAL: Output validation runs BETWEEN pipeline steps — NOT inside the scripts.
// Scripts are pure transforms that assume correct input. server.mjs calls validate_pipeline.mjs
// functions after each step to decide whether to retry or proceed.
// validate_pipeline.mjs exports pure functions: briefHasAllSections(md), briefHasReferences(md), etc.
// Each returns { valid: boolean, reason: string }.

// CRITICAL: generateBrief retry — server.mjs holds a map of validation failure → prompt addition.
// e.g. { noReferences: "Ensure the brief includes a References section with at least one real,
// citable reference from the episode. Do not hallucinate references." }
// The prompt addition is passed to generateBrief via a new `promptAddition` parameter.
// On retry, use force: true to overwrite the existing Supabase row (matched by episode URL/hash).

// CRITICAL: generateBrief force mode must UPDATE the existing Supabase row, not INSERT a new one.
// Find the existing row by transcript_id (episode hash) and overwrite it.
// Do NOT create duplicate rows — the frontend queries by profile_id and would show both.

// CRITICAL: validate-references.mjs — Browserbase session recovery.
// On session death: pop the last null result (the ref that was being tested when session died),
// spin up a NEW Browserbase session, and resume from that same reference (retry all its candidates).
// Use a boolean `hasRetried` flag — only retry once to prevent infinite loops.
// If the second session also dies, write whatever partial results exist and return normally.
// Partial references are better than none — the pipeline continues with what it has.

// CRITICAL: transcribe.mjs cache-hit path — `md` is not defined there.
// Use cached.transcript_md for the return value on the cache-hit branch.

// NOTE: express is not in package.json. Must add it.

// NOTE: Create the Supabase client at module scope in server.mjs (not inside runPipeline)
// so missing env vars cause a fast failure at boot rather than silently per-job.

// NOTE: Pipeline MUST always produce a result. No user-facing errors. If the pipeline
// fails catastrophically, server.mjs should still set status="complete" with whatever
// output exists (even just the transcript), log the full error to briefs.error_log (jsonb column),
// and fire a webhook notification to alert the developer.

// NOTE: briefs table needs a new `error_log` jsonb column. server.mjs writes structured
// error context here whenever the pipeline degrades (retry happened, session died, partial
// references, etc.). Query: SELECT * FROM briefs WHERE error_log IS NOT NULL

// NOTE: WEBHOOK_URL env var — points to a webhook endpoint for developer error alerts.
// server.mjs fires a POST with { briefId, jobId, error, episodeUrl } on pipeline degradation.
// Keep it simple: one fetch() call in the error handling path. No retry on webhook failure.

// NOTE: Email delivery via Resend + Supabase edge function. The edge function triggers on
// briefs row update where status changes to "complete". This is NOT part of server.mjs —
// it's a separate Supabase edge function. Plan the edge function separately.

// NOTE: Resend provides webhooks for delivery tracking (bounced, failed, delivery_delayed).
// Set up a webhook endpoint to catch failed deliveries. Second-pass concern for MVP —
// the Resend dashboard shows delivery status for manual checking.
```

---

## Architecture Overview

```
Browser (Vercel)
  │ POST /api/jobs/brief { episodeUrl }
  ▼
app/api/jobs/brief/route.js   ← Next.js API route (server-side, has WORKER_SECRET)
  │ gets profileId from Supabase session
  │ POST https://<WORKER_URL>/jobs/brief { episodeUrl, profileId }
  │ Authorization: Bearer <WORKER_SECRET>
  ▼
server.mjs on Railway          ← persistent Express process
  │ returns { status: "queued" } immediately
  │ fires runPipeline() in background (no await)
  │ NOTE: no concurrency limit — multiple jobs run simultaneously as async tasks.
  │ Real bottleneck is external API rate limits (Deepgram, OpenRouter, Browserbase),
  │ not the server. Fine for MVP; add a job queue only if rate limit errors appear.
  ▼
runPipeline(episodeUrl, profileId)
  │ creates /tmp/podcast-brief-<jobId>/
  ├─ Step 1: transcribe(episodeUrl, { outputDir })       → { episodeId, transcriptPath }
  ├─ Step 2: generateBrief({ transcriptId, transcriptPath, profileId, outputDir })
  │    → { briefId, outputPath, outputMd }
  │    → writes "generating" row to Supabase, keeps status="generating" (no "complete" yet)
  ├─ Step 2.5: VALIDATE OUTPUT — validateBrief(outputMd)
  │    checks: all expected sections present, references section exists, sections have content
  │    if invalid → retry generateBrief ONCE with { force: true, promptAddition: "<reason-specific nudge>" }
  │    if retry also invalid → accept output, inject placeholder sections, log to error_log
  ├─ Step 3: enrichReferences(outputPath, { outputDir }) → { referencesJsonPath } (null if no refs)
  │    if referencesJsonPath is null after retry+placeholder → use outputMd as final
  ├─ Step 4: validateReferences(referencesJsonPath)      → { referencesMdPath }
  │    on Browserbase session death → pop last null result, new session, resume (1 retry max)
  │    on second death → write partial results, return normally
  ├─ Step 5: mergeReferences({ briefPath: outputPath, referencesPath: referencesMdPath, outputDir })
  │    → { finalBriefMd }
  ├─ Final: supabase.from("briefs").update({
  │    output_markdown: finalBriefMd, status: "complete", completed_at,
  │    error_log: errorLog (null if clean run, jsonb if any degradation occurred)
  │  }) WHERE id = briefId
  │  cleans up /tmp/podcast-brief-<jobId>/
  └─ On ANY unrecoverable error: still set status="complete" with best available output,
     write full error to error_log, fire webhook alert to developer

Developer: Webhook alert on pipeline degradation, error_log column for inspection
NOTE: Email delivery and dashboard rendering are handled in separate plans.
      This server's only job is to set status="complete" + output_markdown in Supabase.
      The email edge function (separate plan) listens for that status change and fires Resend.
```

---

## Implementation Blueprint

### Module API Contract

Each script exports a `run()` function that throws on error instead of calling `process.exit()`.

**transcribe.mjs**
```js
// export
export async function run(appleUrl, { outputDir } = {}) {
  // outputDir defaults to path.join(process.cwd(), "briefs") for CLI compat
  // validates appleUrl starts with https://podcasts.apple.com — throws if not
  // all process.exit(1) → throw new Error(message)
  // process.exit(0) cache hit → return result early (no throw)
  // saveMarkdown uses outputDir instead of hardcoded process.cwd()/briefs
  // returns { episodeId, transcriptPath, transcriptMd }
}
```

**generate-brief.mjs**
```js
// Export a special error class for 409 so server.mjs can handle it specifically
export class BriefExistsError extends Error {}

export async function run({ transcriptId, transcriptPath, profileId, force = false, promptAddition = null, outputDir } = {}) {
  // outputDir defaults to process.cwd() for CLI compat
  // all process.exit(1) → throw new Error(message)
  // process.exit(2) → throw new BriefExistsError(message)
  // file write uses outputDir instead of hardcoded "briefs"
  // if force is true, UPDATE the existing Supabase row (find by transcriptId) instead of inserting
  // if promptAddition is provided (string), append it to the system/user prompt before LLM call
  //   — used by server.mjs retry logic to nudge the LLM on specific failures
  // returns { briefId, outputPath, outputMd }
}
```

**enrich-references.mjs**
```js
export async function run(briefPath, { outputDir } = {}) {
  // outputDir defaults to path.join(process.cwd(), "briefs") for CLI compat
  // all process.exit() → throw or return early
  // outPath uses outputDir instead of process.cwd()/briefs
  // returns { referencesJsonPath }
}
```

**validate-references.mjs**
```js
export async function run(inputPath) {
  // output path already derived from dirname(resolve(inputPath)) — no outputDir needed
  // all process.exit() → throw or return early
  // returns { referencesMdPath }
}
```

**merge-references.mjs**
```js
export async function run({ briefPath, referencesPath, outputDir } = {}) {
  // outputDir defaults to path.join(process.cwd(), "briefs") for CLI compat
  // all process.exit() → throw
  // writeFinal uses outputDir
  // returns { finalBriefPath, finalBriefMd: content }
}
```

**validate_pipeline.mjs**
```js
// Pure validation functions — no side effects, no I/O, no process.exit().
// Called by server.mjs between pipeline steps. Each returns { valid: boolean, reason: string }.

export function briefHasAllSections(md) {
  // Checks that all expected sections (Summary, Key Takeaways, etc.) exist in the markdown
  // and each has non-empty content between headings.
  // Returns { valid: true, reason: null } or { valid: false, reason: "Missing sections: ..." }
}

export function briefHasReferences(md) {
  // Checks that a ## References section exists with at least one entry.
  // Returns { valid: true, reason: null } or { valid: false, reason: "No references section found" }
}

// server.mjs maps validation failures to prompt additions:
// const RETRY_PROMPTS = {
//   noReferences: "Ensure the brief includes a References section with at least one real, citable reference mentioned in the episode. Do not hallucinate references.",
//   missingSections: "Ensure the brief includes all required sections with substantive content in each.",
// };
```

### CLI Shim Pattern (same for all 5 scripts)

Each script exports `run()` for use as a module AND has a shim at the bottom so it still works as a CLI tool. The shim only fires when the file is run directly (`node scripts/transcribe.mjs`), not when imported.

```js
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // parse process.argv as before and call run()
  run(/* args */).catch((err) => { console.error(err.message); process.exit(1); });
}
```

This means existing manual workflows still work unchanged:
```bash
node --env-file=.env.local scripts/transcribe.mjs "https://podcasts.apple.com/..."
node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output-v1.md
```

### server.mjs

```js
import express from "express";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { createClient } from "@supabase/supabase-js";
import { run as transcribe } from "./scripts/transcribe.mjs";
import { run as generateBrief, BriefExistsError } from "./scripts/generate-brief.mjs";
import { run as enrichReferences } from "./scripts/enrich-references.mjs";
import { run as validateReferences } from "./scripts/validate-references.mjs";
import { run as mergeReferences } from "./scripts/merge-references.mjs";
import { briefHasAllSections, briefHasReferences } from "./scripts/validate_pipeline.mjs";

// Retry prompt additions keyed by validation failure type
const RETRY_PROMPTS = {
  noReferences: "Ensure the brief includes a References section with at least one real, citable reference mentioned in the episode. Do not hallucinate references.",
  missingSections: "Ensure the brief includes all required sections with substantive content in each.",
};

// Supabase client at module scope — fails fast at boot if env vars missing
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const app = express();
app.use(express.json());

// Auth — reject any request without the shared secret
app.use((req, res, next) => {
  if (req.headers.authorization !== `Bearer ${process.env.WORKER_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.post("/jobs/brief", (req, res) => {
  const { episodeUrl, profileId } = req.body;
  if (!episodeUrl || !profileId) {
    return res.status(400).json({ error: "episodeUrl and profileId required" });
  }
  res.json({ status: "queued" });
  // Fire and forget — errors logged but don't crash the server
  runPipeline(episodeUrl, profileId).catch((err) =>
    console.error(`[pipeline error] ${err.message}`)
  );
});

// Send webhook alert to developer on pipeline degradation or failure
async function alertDeveloper({ briefId, jobId, error, episodeUrl, context }) {
  if (!process.env.WEBHOOK_URL) return;
  await fetch(process.env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ briefId, jobId, error, episodeUrl, context, timestamp: new Date().toISOString() }),
  }).catch((err) => console.error(`[webhook error] ${err.message}`));
}

async function runPipeline(episodeUrl, profileId) {
  const jobId = randomUUID();
  const jobDir = path.join(os.tmpdir(), `podcast-brief-${jobId}`);
  await mkdir(jobDir, { recursive: true });
  const errorLog = []; // collects degradation events for briefs.error_log

  let briefId = null;
  try {
    // Step 1: Transcribe
    const { episodeId, transcriptPath } = await transcribe(episodeUrl, { outputDir: jobDir });

    // Step 2: Generate brief — keeps status="generating", does NOT set "complete"
    let { briefId: bid, outputPath, outputMd } = await generateBrief({
      transcriptId: episodeId,
      transcriptPath,
      profileId,
      outputDir: jobDir,
    });
    briefId = bid;

    // Step 2.5: Validate output — check sections and references
    const sectionsCheck = briefHasAllSections(outputMd);
    const refsCheck = briefHasReferences(outputMd);

    if (!sectionsCheck.valid || !refsCheck.valid) {
      const reasons = [sectionsCheck, refsCheck].filter((c) => !c.valid).map((c) => c.reason);
      const promptAddition = !refsCheck.valid ? RETRY_PROMPTS.noReferences
        : RETRY_PROMPTS.missingSections;

      errorLog.push({ step: "validate-output", attempt: 1, reasons });
      console.error(`[retry] Brief validation failed: ${reasons.join("; ")} — retrying generateBrief`);

      // Retry generateBrief once with prompt nudge + force overwrite
      ({ briefId: bid, outputPath, outputMd } = await generateBrief({
        transcriptId: episodeId,
        transcriptPath,
        profileId,
        force: true,
        promptAddition,
        outputDir: jobDir,
      }));
      briefId = bid;

      // Check again after retry
      const refsCheck2 = briefHasReferences(outputMd);
      if (!refsCheck2.valid) {
        errorLog.push({ step: "validate-output", attempt: 2, reason: refsCheck2.reason });
        // Inject placeholder references section so brief is structurally complete
        outputMd += "\n\n## References\n\nNo references found.\n";
        // Rewrite the output file with the placeholder
        const { writeFileSync } = await import("fs");
        writeFileSync(outputPath, outputMd, "utf-8");
      }
    }

    // Step 3: Enrich references — returns null if brief has no real REFERENCES entries
    const { referencesJsonPath } = await enrichReferences(outputPath, { outputDir: jobDir });

    let finalBriefMd = outputMd; // fallback: use pre-merge output if no references

    if (referencesJsonPath) {
      // Step 4: Validate references (has internal session recovery — retries once on session death)
      const { referencesMdPath } = await validateReferences(referencesJsonPath);

      // Step 5: Merge references back into brief
      ({ finalBriefMd } = await mergeReferences({
        briefPath: outputPath,
        referencesPath: referencesMdPath,
        outputDir: jobDir,
      }));
    }

    // Final: set status="complete" with merged output + error_log if any degradation
    await supabase
      .from("briefs")
      .update({
        output_markdown: finalBriefMd,
        status: "complete",
        completed_at: new Date().toISOString(),
        error_log: errorLog.length > 0 ? errorLog : null,
      })
      .eq("id", briefId);

    if (errorLog.length > 0) {
      await alertDeveloper({ briefId, jobId, error: "Pipeline completed with degradation", episodeUrl, context: errorLog });
    }

    console.log(`✓ Pipeline complete [job=${jobId}]${errorLog.length > 0 ? " (degraded)" : ""}`);
  } catch (err) {
    // Unrecoverable error — still try to save whatever we have
    console.error(`[pipeline error] ${err.message}`);
    errorLog.push({ step: "unrecoverable", error: err.message, stack: err.stack });

    if (briefId) {
      await supabase
        .from("briefs")
        .update({
          status: "complete",
          completed_at: new Date().toISOString(),
          error_log: errorLog,
        })
        .eq("id", briefId)
        .catch(() => {});
    }
    await alertDeveloper({ briefId, jobId, error: err.message, episodeUrl, context: errorLog });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Worker listening on port ${PORT}`));
```

### app/api/jobs/brief/route.js (Next.js proxy)

```js
import { createClient } from "@/libs/supabase/server"; // existing helper — same as auth/callback

export async function POST(req) {
  const { episodeUrl } = await req.json();
  if (!episodeUrl) {
    return Response.json({ error: "episodeUrl required" }, { status: 400 });
  }

  // Get profileId from authenticated session (server-side only)
  const supabase = createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Proxy to Railway worker (WORKER_SECRET never exposed to browser)
  const workerRes = await fetch(`${process.env.WORKER_URL}/jobs/brief`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_SECRET}`,
    },
    body: JSON.stringify({ episodeUrl, profileId: user.id }),
  });

  if (!workerRes.ok) {
    const err = await workerRes.json().catch(() => ({}));
    return Response.json({ error: err.error ?? "Worker error" }, { status: workerRes.status });
  }

  return Response.json({ status: "queued" });
}
```

### app/onboarding/page.js changes

Wire up the Generate Brief button:
- Add `loading` and `error` state
- On submit: POST to `/api/jobs/brief` with `{ episodeUrl: url }`
- On success: show "Your brief is on its way — check your email in a few minutes." (no spinner, no polling)
- On error: show error message inline
- Disable button while loading
- NOTE: No real-time polling needed. The pipeline takes ~5 minutes. User submits and leaves.
  Email (via Resend) is the primary delivery mechanism. Dashboard shows the brief when user logs in later.

---

## Tasks (in implementation order)

```yaml
Task 1:
ADD express to package.json dependencies:
  - Run: npm install express
  - Verify it appears in dependencies (not devDependencies)

Task 2:
MODIFY scripts/transcribe.mjs:
  - WRAP all top-level code (from `const appleUrl = process.argv[2]` down) in:
      export async function run(appleUrl, { outputDir } = {})
  - SET outputDir default: path.join(process.cwd(), "briefs")
  - REPLACE all process.exit(1) with: throw new Error(message)
  - REPLACE process.exit(0) cache-hit path:
      saveMarkdown(episode.episodeId, cached.transcript_md, outputDir)
      return { episodeId: episode.episodeId, transcriptPath, transcriptMd: cached.transcript_md }
      NOTE: use cached.transcript_md directly — `md` is not defined in the cache-hit scope
  - CHANGE saveMarkdown to accept outputDir and use it instead of path.join(process.cwd(), "briefs")
  - CHANGE return at end of happy path: return { episodeId: episode.episodeId, transcriptPath, transcriptMd: md }
  - MOVE top-level entry point code into CLI shim at bottom (fileURLToPath pattern)
  - Shim parses process.argv[2] as appleUrl and calls run(appleUrl)

Task 3:
MODIFY scripts/generate-brief.mjs:
  - ADD export class BriefExistsError extends Error {} near top
  - WRAP all execution code in:
      export async function run({ transcriptId, transcriptPath, profileId, force = false, promptAddition = null, outputDir } = {})
  - SET outputDir default: process.cwd() for CLI compat
  - REPLACE all process.exit(1) with: throw new Error(message)
  - REPLACE process.exit(2) with: throw new BriefExistsError(message)
  - ADD `promptAddition` parameter (string, default null):
      if provided, append to system/user prompt before LLM call
      used by server.mjs retry logic to nudge LLM on specific validation failures
  - CHANGE file write: use outputDir directly (NOT path.join(outputDir, "briefs"))
      mkdirSync(outputDir, { recursive: true })
      const outputFile = path.join(outputDir, `${transcriptId}-output-v${version}.md`)
      existsSync check also uses path.join(outputDir, ...)
  - REMOVE process.stdout.write(disclaimer + brief) — CLI pipe convenience, pollutes server logs
  - CHANGE Supabase update at end: keep status="generating", do NOT set status="complete" or completed_at
      (server.mjs does the final status update after all 5 steps)
  - CHANGE force mode behavior: when force=true, UPDATE existing Supabase row (find by transcriptId)
      instead of inserting a new one. Do NOT create duplicate rows.
  - RETURN { briefId, outputPath, outputMd: brief }
  - MOVE top-level entry point code into CLI shim at bottom (fileURLToPath pattern)
  - Shim parses process.argv (transcriptId, transcriptPath, profileId, --force) and calls run()
  - Shim exits with code 2 for BriefExistsError, 1 for all other errors

Task 4:
MODIFY scripts/enrich-references.mjs:
  - WRAP all execution code in:
      export async function run(briefPath, { outputDir } = {})
  - SET outputDir default: path.join(process.cwd(), "briefs")
  - REPLACE process.exit(1) with throw new Error(message)
  - REPLACE process.exit(0) early exits (no REFERENCES section, all refs filtered out):
      return { referencesJsonPath: null }   ← NOT undefined, explicit null
  - CHANGE outPath to use outputDir instead of path.join(process.cwd(), "briefs")
  - RETURN { referencesJsonPath: outPath } at end of happy path
  - MOVE top-level entry point code into CLI shim at bottom (fileURLToPath pattern)
  - Shim parses process.argv[2] as inputPath and calls run(inputPath)

Task 5:
MODIFY scripts/validate-references.mjs:
  - WRAP all execution code in:
      export async function run(inputPath)
  - NOTE: outPath is already derived from dirname(resolve(inputPath)) — no outputDir needed, works with absolute paths
  - REPLACE process.exit(1) with throw new Error(message)
  - ADD Browserbase session recovery with one retry:
      On session death (Target closed, Session expired, Protocol error, Connection closed):
        1. Pop the last null result from `results` (the ref being tested when session died)
        2. If `hasRetried` is false:
           - Set hasRetried = true
           - Create a NEW Browserbase session + browser connection
           - Resume the for loop from refs[results.length] (the popped ref, all candidates retried)
           - Continue through remaining refs normally
        3. If `hasRetried` is true (second death):
           - Write whatever partial results exist to disk
           - Log structured error (same format as current)
           - Return { referencesMdPath: outPath } with partial results
      This replaces the current "break on session death" behavior with a single retry.
      Partial results are always written — the pipeline continues with what it has.
  - RETURN { referencesMdPath: outPath }
  - MOVE top-level entry point code into CLI shim at bottom (fileURLToPath pattern)
  - Shim parses process.argv[2] as inputPath and calls run(inputPath)

Task 6:
MODIFY scripts/merge-references.mjs:
  - WRAP all execution code in:
      export async function run({ briefPath, referencesPath, outputDir } = {})
  - SET outputDir default: path.join(process.cwd(), "briefs")
  - REPLACE all process.exit() with throw
  - CHANGE writeFinal to use outputDir instead of process.cwd()/briefs
  - RETURN { finalBriefPath, finalBriefMd: finalBrief } (capture content before writing)
  - MOVE top-level entry point code into CLI shim at bottom (fileURLToPath pattern)
  - Shim parses process.argv[2] as briefPath, process.argv[3] as referencesPath

Task 7:
CREATE scripts/validate_pipeline.mjs:
  - Single file with ALL pipeline step validation functions
  - Export pure functions, each returns { valid: boolean, reason: string }
  - No side effects, no I/O, no process.exit(), no CLI shim
  - briefHasAllSections(md) — checks all expected extract_wisdom sections exist with non-empty content
  - briefHasReferences(md)  — checks ## REFERENCES heading exists with at least one entry
  - (Add more step validators here as the pipeline grows — one file, all pipeline validation)

Task 8:
CREATE server.mjs:
  - Implement as shown in pseudocode above (includes retry logic, validation, error_log, webhook alerts)
  - Required env vars: WORKER_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY,
    DEEPGRAM_API_KEY, OPENROUTER_API_KEY, EXA_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID,
    WEBHOOK_URL (optional — for developer error alerts)
  - Listen on process.env.PORT || 3001

Task 9:
CREATE railway.toml:
  - Content:
    [deploy]
    startCommand = "node server.mjs"

Task 10:
CREATE app/api/jobs/brief/route.js:
  - Implement as shown in pseudocode above
  - IMPORTANT: Use the existing helper at @/libs/supabase/server to create the Supabase client
      (same pattern as app/api/auth/callback/route.js) — do NOT re-implement the cookie adapter
  - Required env vars: WORKER_URL, WORKER_SECRET (server-side only, never NEXT_PUBLIC_)
  - NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY already available

Task 11:
MODIFY app/onboarding/page.js:
  - ADD loading and error state (useState)
  - ADD handleSubmit async function:
      POST /api/jobs/brief with { episodeUrl: url }
      on success: show "Your brief is on its way — check your email in a few minutes."
      on error: setError(err.message)
  - WIRE button onClick to handleSubmit
  - REMOVE disabled attribute from button
  - ADD disabled={loading || !url} to button
  - NO spinner/polling — user submits and leaves. Show "Your brief is being generated — we'll let you know when it's ready." (email delivery wired up in separate plan)

Task 12:
MODIFY .env.example:
  - ADD WORKER_SECRET= (server-side only, shared between Vercel and Railway)
  - ADD WORKER_URL= (Railway public URL, server-side only)
  - ADD WEBHOOK_URL= (optional — developer error alert webhook endpoint)

Task 13:
CREATE supabase/migrations/20260331000000_add_error_log_to_briefs.sql:
  - Content:
    -- Stores structured pipeline degradation events per brief run.
    -- NULL = clean run. Non-null = at least one retry/partial-result/unrecoverable error occurred.
    -- Query degraded briefs: SELECT id, error_log FROM briefs WHERE error_log IS NOT NULL;
    ALTER TABLE public.briefs ADD COLUMN IF NOT EXISTS error_log jsonb DEFAULT null;
  - Follow the same migration style as existing files in supabase/migrations/
```

---

## Validation Loop

```bash
# After implementation, verify no syntax errors in modified scripts
node --check scripts/transcribe.mjs
node --check scripts/generate-brief.mjs
node --check scripts/enrich-references.mjs
node --check scripts/validate-references.mjs
node --check scripts/merge-references.mjs
node --check scripts/validate_pipeline.mjs
node --check server.mjs

# Verify CLI shims still work (dry run — expects missing args to print usage)
node --env-file=.env.local scripts/transcribe.mjs
# Expected: prints usage error, exits 1

node --env-file=.env.local scripts/generate-brief.mjs
# Expected: prints usage error, exits 1

# Verify server starts
node --env-file=.env.local server.mjs
# Expected: "Worker listening on port 3001"

# Lint
npm run lint
```

---

## Deployment Checklist (manual steps after implementation)

1. Push branch to GitHub
2. Create new Railway project → "Deploy from GitHub repo" → select this repo
3. In Railway service Settings → Deploy: Railway will use `railway.toml` startCommand automatically
4. In Railway service Variables, add all env vars from `.env.example` (the non-NEXT_PUBLIC_ ones + Deepgram/OpenRouter/Exa/Browserbase keys + WEBHOOK_URL)
5. Railway gives you a public URL (e.g. `https://podcast-brief-worker.up.railway.app`) — copy it
6. In Vercel, add env vars: `WORKER_URL=<railway-url>` and `WORKER_SECRET=<same-secret-as-railway>`
7. Run Supabase migration: `ALTER TABLE briefs ADD COLUMN error_log jsonb DEFAULT null;`
8. Set up WEBHOOK_URL to point to your developer alert endpoint
9. Redeploy Vercel

---

## Deprecated / Removed Code

None — CLI entry point code moves into shims at the bottom of each file. All existing manual workflows preserved.
