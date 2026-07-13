# Plan: validate-references.mjs with Browserbase

**Prerequisite:** `2026-03-25-upgrade-enrich-references.md` must be implemented first.
`enrich-references.mjs` must already write `briefs/{podcastID}-references.json`.

## Goal

Add `scripts/validate-references.mjs` — reads the JSON candidates file from `enrich-references.mjs`, uses one Browserbase session to try each candidate URL in order, picks the first valid one, and writes the final `briefs/{podcastID}-references.md` that `merge-references.mjs` already expects.

`enrich-references.mjs` and `merge-references.mjs` are **not touched** by this plan.

## What

**CLI usage:**
```bash
node --env-file=.env.local scripts/validate-references.mjs briefs/abc123-references.json
# writes → briefs/abc123-references.md
```

**Behavior:**
- For each reference: try candidates in order, stop at first valid page
- Valid = HTTP 200 AND page title doesn't contain error strings
- All candidates fail → name-only entry (no link) — this is correct output, not a failure
- One Browserbase session for the entire file (not per-URL, not per-reference)
- Logs each result: `✓ Name` or `✗ Name (all candidates failed)`

**What counts as failure (exit 1):**
The script has three and only three failure conditions — everything else is just data:
1. Cannot read the input file (file missing, permission error)
2. Cannot create the Browserbase session (bad credentials, network error)
3. Cannot write the output file (disk error, permission error)

All candidates failing validation is NOT a failure — the check is intentionally barebones
(HTTP 200 + title heuristic). A "failed" reference just gets written as name-only. Even
the case where zero references produce valid links is not a failure — the script still did
its job. It tried every candidate, applied the check honestly, and wrote what it found.
The orchestrator (not yet implemented) is responsible for deciding what to do with the output.

**Full pipeline after both plans:**
```bash
node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# → briefs/abc123-references.json

node --env-file=.env.local scripts/validate-references.mjs briefs/abc123-references.json
# → briefs/abc123-references.md

node scripts/merge-references.mjs briefs/abc123-output.md briefs/abc123-references.md
# → briefs/abc123-final-brief.md
```

### Success Criteria

- [ ] Script reads `briefs/{podcastID}-references.json` (shape: `[{ name, candidates: string[] }]`)
- [ ] One Browserbase session created per invocation
- [ ] Candidates tried in order, stops at first valid URL
- [ ] All-fail references appear as name-only in output
- [ ] Output is `{inputDir}/{podcastID}-references.md` with `# Enriched References` header
- [ ] Both Browserbase env vars checked at startup
- [ ] Input filename guard — exits if input doesn't end in `-references.json` (checks ext AND stem)
- [ ] `browser?.close()` in `finally` block; `let browser` declared before try
- [ ] `writeFileSync` wrapped in try/catch → clean error + exit 1
- [ ] Summary line logged: `→ X/Y validated`
- [ ] `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` added to `.env.example`
- [ ] `@browserbasehq/sdk` and `playwright-core` in `devDependencies` with caret versions
- [ ] `docs/how-pipeline-works.md` updated to reflect full pipeline as current

## All Needed Context

### Documentation & References

```yaml
- url: https://docs.browserbase.com/reference/sdk/nodejs
  why: Session creation, connectOverCDP, page.goto response status

- file: scripts/enrich-references.mjs
  why: Follow env check style and stderr logging conventions. Do NOT copy parseReferences —
       this script reads JSON directly, no markdown parsing needed.
```

### Files Being Changed

```
scripts/
  validate-references.mjs   ← NEW
.env.example                ← MODIFIED (EXA section header + Browserbase section)
package.json                ← MODIFIED (2 new devDependencies)
```

### Session Cost & Time Estimates (60 references, 3 candidates each)

```
Candidates tried per reference: 1 (best, first valid) to 3 (all fail)

Best case:  60 refs × 1 URL × 3s =  3 min  → ~0.05 browser hrs
Avg case:   60 refs × 1.5 URLs × 4s =  6 min  → ~0.10 browser hrs
Worst case: 60 refs × 3 URLs × 5s = 15 min  → ~0.25 browser hrs

Billing (browser hours only):
  Free tier   ($0/mo,   1 hr included):  4–20 full runs before paying
  Developer   ($20/mo, $0.12/hr overage): $0.006–$0.03 per run
  Startup     ($99/mo, $0.10/hr overage): $0.005–$0.025 per run

Session time limit:
  Free tier:  15 min max → worst case (all 3 tried, 60 refs) hits the limit ⚠
  Paid tiers: 6 hours    → no concern
```

### Known Gotchas & Library Quirks

```js
// CRITICAL: Browserbase requires TWO env vars — BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.

// CRITICAL: Get the page via browser.contexts()[0].pages()[0] — NOT browser.newPage().
// newPage() creates a tab outside the recorded session context.

// CRITICAL: page.goto() can return null if navigation is aborted — use response?.status().

// CRITICAL: page.goto() throws on network errors (DNS failure, connection refused).
// Catch the throw and treat it as an invalid URL — try the next candidate.

// CRITICAL: browser.close() must be in a finally block — any uncaught exception
// between session creation and close leaves a dangling Browserbase session.

// CRITICAL: Declare `let browser` BEFORE the try block. Move session creation and
// connectOverCDP INSIDE the try block. Use `browser?.close()` in finally.
// If connectOverCDP throws, `browser` is undefined — `browser.close()` would throw
// a ReferenceError, masking the real error (partial initialization / RAII pattern).

// CRITICAL: session.connectUrl is the correct property name in Browserbase SDK v2.
// (Not session.wsEndpoint or session.connectWsUrl — those are v1 names.)

// NOTE: Top-level await works in .mjs files by default in Node.js 14.8+.
// ESLint's ecmaVersion must be >= 2022 to parse it without errors.
// enrich-references.mjs already uses top-level await and passes lint — same will apply here.

// WARNING: Free-tier Browserbase sessions expire after 15 min. If session dies mid-run,
// page.goto throws "Target closed" or similar CDP errors. validateUrl catches these as
// invalid — remaining references will silently produce name-only entries rather than
// a loud failure. Watch for repeated "Target closed" errors in logs as a signal.
// Paid tiers have a 6-hour limit — no concern for typical brief sizes.

// WARNING: If validateUrl returns a reason containing "Target closed" or "Session expired",
// the Browserbase session is dead — all subsequent page.goto() calls will also fail.
// Detect this in the main loop and break early with a structured JSON error log.
//
// Railway structured logging: emit JSON to stdout via console.log — Railway parses it,
// indexes it, and makes it filterable in the log explorer. level:"error" gets severity
// treatment. All other per-reference logs use console.error (stderr) as before.
//
// Session death log format (one JSON line to stdout):
// {
//   "level": "error",
//   "message": "Browserbase session died mid-run",
//   "podcastID": "...",
//   "reference": "...",
//   "candidateIndex": N,
//   "candidateTotal": N,
//   "reason": "...",
//   "skipped": N,
//   "action": "rerun validate-references.mjs to retry"
// }

// NOTE: Output path is derived from path.dirname(path.resolve(inputPath)), not process.cwd().
// This makes the script safe to call with an absolute path from a backend server (e.g.
// `/tmp/jobs/abc123/abc123-references.json` → `/tmp/jobs/abc123/abc123-references.md`).
// The output dir already exists (it's where the input came from) — no mkdirSync needed.

// NOTE: Railway captures both stdout and stderr in its log explorer, but only stdout
// is parsed as structured JSON. stderr is plain text. This is why session death
// logs use console.log (stdout/structured) and all other logs use console.error (stderr/plain).

// NOTE: Output header must be "# Enriched References" — merge-references.mjs does not
// care about the heading text, but keep it consistent with enrich's previous output.
```

## Implementation Blueprint

### Key Pseudocode

```js
// ── imports ───────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";

// ── env check ─────────────────────────────────────────────────────────────────
for (const key of ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
}

// ── input arg + filename guard ────────────────────────────────────────────────
const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/validate-references.mjs <podcastID-references.json>");
  process.exit(1);
}
const ext = path.extname(inputPath);
const stem = path.basename(inputPath, ext);
if (ext !== ".json" || !stem.endsWith("-references")) {
  console.error(`Error: input must be a *-references.json file (got: ${path.basename(inputPath)})`);
  process.exit(1);
}
const podcastID = stem.replace(/-references$/, "");

// ── validate a single URL ─────────────────────────────────────────────────────
const ERROR_STRINGS = ["404", "not found", "page not found", "access denied", "forbidden"];

async function validateUrl(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    if (!response || response.status() !== 200) {
      return { valid: false, reason: `HTTP ${response?.status() ?? "no response"}` };
    }
    const title = (await page.title()).toLowerCase();
    const matched = ERROR_STRINGS.find((s) => title.includes(s));
    if (matched) return { valid: false, reason: `title contains "${matched}"` };
    return { valid: true, reason: null };
  } catch (e) {
    // "Target closed" / "Session expired" errors mean the Browserbase session died.
    // validateUrl catches them as invalid to avoid an unhandled throw, but the caller
    // should watch for these strings in logs — remaining refs will all fail silently.
    return { valid: false, reason: e.message };
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
// File existence: readFileSync throws with a decent message if file is missing,
// but catch and re-throw with usage hint for clarity.
let refs;
try {
  refs = JSON.parse(readFileSync(inputPath, "utf-8"));
} catch (e) {
  console.error(`Error: cannot read input file: ${e.message}`);
  console.error(`Usage: node scripts/validate-references.mjs <podcastID-references.json>`);
  process.exit(1);
}
if (!Array.isArray(refs)) {
  console.error("Error: input JSON must be an array");
  process.exit(1);
}
console.error(`Validating ${refs.length} references via Browserbase...`);

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const results = [];
let browser;
try {
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  browser = await chromium.connectOverCDP(session.connectUrl);
  const page = browser.contexts()[0].pages()[0];
  for (const ref of refs) {
    if (!ref.candidates.length) {
      results.push({ name: ref.name, url: null });
      continue;
    }
    let found = null;
    let sessionDead = false;
    for (const url of ref.candidates) {
      const { valid, reason } = await validateUrl(page, url);
      if (reason?.includes("Target closed") || reason?.includes("Session expired") || reason?.includes("Protocol error") || reason?.includes("Connection closed")) {
        sessionDead = true;
        results.push({ name: ref.name, url: null }); // keep results complete before breaking
        // Structured JSON log to stdout — Railway indexes this for filtering/alerting
        console.log(JSON.stringify({
          level: "error",
          message: "Browserbase session died mid-run",
          podcastID,
          referenceIndex: results.length, // 1-based index of the failing ref (pushed above, so length === index)
          referenceTotal: refs.length,
          reference: ref.name,
          candidateIndex: ref.candidates.indexOf(url) + 1, // which URL was being tried (1 = first, 2 = second, 3 = third)
          candidateTotal: ref.candidates.length,           // how many candidate URLs this reference had (1–3)
          reason,
          skipped: refs.length - results.length, // current ref already pushed above
          action: "rerun validate-references.mjs to retry",
        }));
        break;
      }
      if (valid) { found = url; break; }
      console.error(`    ✗ ${url} (${reason})`);
    }
    if (sessionDead) break; // break outer for loop too
    if (found) {
      console.error(`  ✓ ${ref.name}`);
      results.push({ name: ref.name, url: found });
    } else {
      console.error(`  ✗ ${ref.name} (all candidates failed)`);
      results.push({ name: ref.name, url: null });
    }
  }
} finally {
  await browser?.close();
}

const validated = results.filter((r) => r.url).length;
console.error(`→ ${validated}/${results.length} validated`);

// ── write markdown for merge-references.mjs ───────────────────────────────────
const lines = results.map((r) => r.url ? `- [${r.name}](${r.url})` : `- ${r.name}`);
const output = `# Enriched References\n\n${lines.join("\n")}\n`;

// Output path derived from input path — works with absolute paths from a backend server.
// Avoids process.cwd() dependency; output always lands beside the input .json file.
// NOTE: enrich-references.mjs still uses process.cwd()/briefs — that's a local-only script.
const outPath = path.join(path.dirname(path.resolve(inputPath)), `${podcastID}-references.md`);
try {
  writeFileSync(outPath, output, "utf-8");
} catch (e) {
  console.error(`Error: cannot write output file: ${e.message}`);
  process.exit(1);
}
console.error(`✓ Written to ${outPath}`);
```

### Tasks (in implementation order)

```yaml
Task 1:
INSTALL packages:
  RUN: npm install --save-dev @browserbasehq/sdk playwright-core
  Verify both appear in devDependencies with caret versions (e.g. "^2.0.0")
  Commit package.json AND package-lock.json together

Task 2:
MODIFY .env.example:
  - EXA_API_KEY and OPENROUTER_API_KEY are currently bare trailing lines after the Stripe
    block — they have NO existing section header. Add one before them.
  - Add Browserbase section after, matching the same # --- comment block style:

    # -----------------------------------------------------------------------------
    # Scripts: Exa + OpenRouter
    # -----------------------------------------------------------------------------
    EXA_API_KEY=
    OPENROUTER_API_KEY=

    # -----------------------------------------------------------------------------
    # Browserbase: https://browserbase.com
    # -----------------------------------------------------------------------------
    BROWSERBASE_API_KEY=
    BROWSERBASE_PROJECT_ID=

Task 3:
CREATE scripts/validate-references.mjs:
  - Use pseudocode above verbatim
  - Section order: imports → env check → input arg + filename guard → validateUrl fn → main
  - ERROR_STRINGS: "404", "not found", "page not found", "access denied", "forbidden"
    ("error" intentionally excluded — too broad, common English word in legitimate titles)
  - `let browser` declared BEFORE try block; session + connectOverCDP INSIDE try block;
    `browser?.close()` in finally (safe no-op if connectOverCDP threw)
  - writeFileSync wrapped in try/catch → clean error + process.exit(1)
  - Output header: "# Enriched References"
  - Output path: path.join(path.dirname(path.resolve(inputPath)), `${podcastID}-references.md`)
    (no mkdirSync — output dir already exists; safe for absolute paths from a backend server)

Task 4:
MODIFY docs/how-pipeline-works.md:
  - Replace the "Current (implemented)" header and its code block with the new three-step pipeline:
      node scripts/enrich-references.mjs   → briefs/{id}-references.json
      node scripts/validate-references.mjs → briefs/{id}-references.md
      node scripts/merge-references.mjs    → briefs/{id}-final-brief.md
  - Delete the "With Browserbase validation (planned)" section entirely — it is now current
  - Leave the Design Principles section unchanged
```

## Validation Loop

```bash
# Confirm prerequisite: enrich must have run and produced JSON
ls briefs/*-references.json
# If missing: run enrich-references.mjs first

# (packages already installed in Task 1 — confirm package-lock.json updated)

node --env-file=.env.local scripts/validate-references.mjs briefs/<podcastID>-references.json
# Expected: session created, refs logged ✓ or ✗, briefs/<podcastID>-references.md written

cat briefs/<podcastID>-references.md
# Expected: "# Enriched References" header, entries as [Name](url) or plain Name

npx eslint scripts/validate-references.mjs
# (npm run lint uses next lint which only covers app/ dirs — use npx eslint directly for scripts/)
```

## Final Validation Checklist

- [ ] `npx eslint scripts/validate-references.mjs` passes
- [ ] Both Browserbase env vars checked at startup with `process.exit(1)`
- [ ] Input arg check with usage message
- [ ] Input filename guard rejects non-`*-references.json` files
- [ ] Input parsed with `JSON.parse` (no markdown parsing); shape-checked with `Array.isArray` after parsing
- [ ] Candidates tried in order, stops at first valid URL
- [ ] `page.goto()` wrapped in try/catch inside `validateUrl`
- [ ] `browser?.close()` in `finally` block; `let browser` declared before try
- [ ] No `mkdirSync` — output dir derived from input path, already exists
- [ ] ERROR_STRINGS includes exactly 5 strings: "404", "not found", "page not found", "access denied", "forbidden" — "error" intentionally excluded (too broad, soft 404s already caught by "not found")
- [ ] Output header is `# Enriched References`
- [ ] Output path uses `path.dirname(path.resolve(inputPath))`, not `process.cwd()`
- [ ] `package.json` has both new devDependencies with caret versions
- [ ] `.env.example` has full `# ---` blocks for EXA and Browserbase sections
- [ ] Session death ("Target closed" / "Session expired" / "Protocol error" / "Connection closed") breaks the outer loop and emits one structured JSON log line via `console.log`
- [ ] JSON log includes: `level:"error"`, `message`, `podcastID`, `referenceIndex`, `referenceTotal`, `reference`, `candidateIndex`, `candidateTotal`, `reason`, `skipped`, `action`
- [ ] All other per-reference logs use `console.error` (stderr) — only session death uses `console.log` (stdout/Railway structured)
- [ ] NOTE: If Railway logs show session deaths not matching the three detection strings, add the new string to the `reason?.includes()` chain

## Why Browserbase Sessions Fail (Production Research)

Session failures are **fully predictable** — no mystery failures reported anywhere in the wild.

### The two causes you'll actually hit

1. **Free-tier 15-min hard cap**
   Worst case (60 refs × 3 candidates × ~5s each) lands right at the boundary.
   Fix: upgrade to a paid plan. 6-hour limit → essentially never a problem.

2. **CDP inactivity timeout: 10 min without any CDP command**
   If code is doing anything slow (waiting on an API, sleeping) without issuing a CDP
   command, the WebSocket closes even though the session is still allocated. Next
   `page.goto()` throws `Target closed`.
   **Not a risk for this script** — session is created immediately before the loop and
   `page.goto()` runs continuously with no gaps.

### What people actually report in the wild

- Reddit: nothing on Browserbase specifically — too niche
- GitHub (Browserbase/Stagehand repos): only real-world session drops were from a
  **Bun/Playwright WebSocket incompatibility** (code 1006 abnormal closure) — not a
  Node.js issue
- Stagehand framework had a bug where `process.once('unhandledRejection')` removed the
  handler after the first CDP error, crashing on a second one — not relevant since this
  script uses playwright-core directly, not Stagehand

### Known error strings when a session dies

- `"has been closed"` — actual Playwright error: `"Target page, context or browser has been closed"` — note `"Target closed"` does NOT match this
- `"Target closed"` — kept as fallback for older Playwright versions
- `"Session expired"` — Browserbase-specific
- `"Protocol error"` — CDP protocol error on a closed session
- `"Connection closed"` — WebSocket-level closure

### Bottom line

In this setup the only realistic production failure is hitting the free-tier time cap on a
large batch. On a paid plan, session death is essentially theoretical.
