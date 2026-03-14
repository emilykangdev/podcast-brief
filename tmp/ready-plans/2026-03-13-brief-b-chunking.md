# Plan B: Transcript → Brief (Extract Wisdom + Chunking)

## Goal

A standalone Node.js script (`scripts/generate-brief.mjs`) that reads a `.md` transcript, loads `prompts/extract_wisdom.md` as the system prompt, and calls OpenAI to produce a polished Markdown brief. Handles long transcripts by chunking: splits at turn boundaries, extracts from each chunk in parallel, then does one merge call to produce a single clean output. Saves the result to Supabase `briefs.output_markdown` with the ID as the transcriptId and writes a local file named after the transcript's UUID.

**Branch:** `brief-b-chunking`
**Prerequisite:** None — this is the base script.

## What

```bash
node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> path/to/transcript.md "Episode Title" "Description" <profileId>
# → prints markdown brief to stdout
# → writes {transcriptId}-output.md in cwd
# → saves output_markdown to supabase briefs table
```

**IMPORTANT: `"Description"` must always be passed — use `""` as a placeholder if omitted.
`profileId` is the 5th positional arg; if description is skipped, profileId silently binds to it.**

### Success Criteria

- [ ] Script runs end-to-end on `transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md` without error
- [ ] Output contains the sections from `prompts/extract_wisdom.md` (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS)
- [ ] Short transcripts (fits in one chunk) make exactly one API call
- [ ] Long transcripts (simulated by setting `CHUNK_CHAR_SIZE = 500`) split, extract in parallel, then merge into one clean brief
- [ ] Chunks always split on `\n\n**[` turn boundaries — never mid-sentence
- [ ] Script exits cleanly with a message if `OPENAI_API_KEY` is missing
- [ ] Script exits cleanly if `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SECRET_KEY` is missing
- [ ] Script exits cleanly if transcript path is missing, wrong extension, or not found
- [ ] Script exits cleanly if `prompts/extract_wisdom.md` is not found
- [ ] `{transcriptId}-output.md` is written on completion
- [ ] `briefs` row is inserted with `status = 'generating'` at startup, then updated to `status = 'complete'` with `output_markdown` on success
- [ ] Re-running the script for the same `(transcriptId, profileId)` exits with code 409 if a `complete` or `generating` row already exists — no AI calls made
- [ ] stdout and `{transcriptId}-output.md` contents are identical

---

## All Needed Context

### Chunking Strategy

GPT-4o context: 128K tokens. Each token ≈ 4 chars.
- `CHUNK_CHAR_SIZE = 400_000` chars ≈ 100K tokens (leaves room for system prompt + output)
- Most real podcast transcripts are under this — single call, no chunking needed
- When chunking: extract_wisdom runs on each chunk in parallel → markdown outputs → one merge call

### Merge Strategy

When there are multiple chunks, each produces a full extract_wisdom brief. A final call receives all chunk briefs and merges them into one, deduplicating across sections. The merge prompt: "here are N briefs from consecutive segments of the same podcast — combine into one clean brief in the same format, no duplicates."

Merge call uses `maxTokens: 16000` — same budget as a single extraction. The merge input (N full briefs) can be large, but the output is one consolidated brief, so 16K tokens is sufficient.

### 409 Check (Before Any AI Calls)

Before inserting or calling OpenAI, query for an existing `complete` or `generating` brief for this `(profile_id, input_url)` pair:

- `complete` → brief already done, frontend should fetch it from Supabase directly
- `generating` → already in progress, frontend should poll for completion

Either way: **exit immediately, no AI calls**. The CLI exits with code `2`. The HTTP handler wrapping this script maps exit codes to HTTP responses:

```js
// Exit codes:
// 0 — success
// 1 — general error
// 2 — brief already exists (409 conflict)
if (exitCode === 2) return res.status(409).json({ error: "Brief already exists" });
```

The frontend is expected to check Supabase first and never hit the backend if a brief already exists — but the backend check is the authoritative guard against race conditions and direct API calls.

### Supabase Save (Two-Step)

Insert `status: "generating"` at startup so crashes leave a visible row, then update to `status: "complete"` with `output_markdown` on success:

```js
// Step 1 — at startup, before API calls
const { data: briefRow, error: insertError } = await supabase
  .from("briefs")
  .insert({
    profile_id: profileId,
    input_url: transcriptId,
    status: "generating",
  })
  .select("id")
  .single();
if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`);
const briefId = briefRow.id;

// Step 2 — after generation
const { error: updateError } = await supabase
  .from("briefs")
  .update({
    output_markdown: brief,
    status: "complete",
    completed_at: new Date().toISOString(),
  })
  .eq("id", briefId);
if (updateError) throw new Error(`Supabase update failed: ${updateError.message}`);
```

`@supabase/supabase-js` is already in `package.json` — no new dependency.
Use service role key (`SUPABASE_SECRET_KEY`) — bypasses RLS.

**Note on `profile_id`:** The `briefs` table has `profile_id uuid not null`. The script accepts it as a required CLI arg. In future, the web app will pre-create the brief row (status='pending') and pass the brief ID instead.

### Output File

Named `{transcriptId}-output.md` and written to cwd. Written **before** stdout so the file is the durable artifact — if the process crashes between the two writes, stdout is the lossy end.

### Prompt File

`prompts/extract_wisdom.md` — loaded at runtime. Passed verbatim as system message. Outputs plain Markdown (not JSON).

Resolve path relative to the script file using `import.meta.url` so it works from any working directory.

### Environment Variables

```bash
OPENAI_API_KEY              # must be set in .env.local
NEXT_PUBLIC_SUPABASE_URL    # already in .env.local
SUPABASE_SECRET_KEY         # already in .env.local
```

Run with `node --env-file=.env.local` — no `dotenv` import needed.

### No New Dependencies

Node.js built-ins (`fs`, `path`, `url`), native `fetch` (Node 18+), and `@supabase/supabase-js` (already installed).

### Reference Pattern

```yaml
- file: scripts/transcribe.mjs
  why: ESM script structure, arg parsing, env checking, Supabase client pattern
  note: creates supabase client with createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY)
        uses console.log() for progress — this script uses console.error() to keep stdout clean
```

### Known Gotchas

```js
// CRITICAL: Run with `node --env-file=.env.local` — no dotenv import.

// CRITICAL: All imports at top — ESM imports are static.

// CRITICAL: Resolve prompt path with import.meta.url, NOT process.cwd().
//   const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../prompts/extract_wisdom.md");

// CRITICAL: callOpenAI() must check res.ok before reading body.
//   On errors, data.choices will be undefined → TypeError.

// CRITICAL: callOpenAI() must guard against empty choices array (safety filter / edge case):
//   const data = await res.json();
//   if (!data.choices?.length) throw new Error(`OpenAI returned no choices: ${JSON.stringify(data)}`);
//   return data.choices[0].message.content;

// CRITICAL: Use console.error() for ALL progress logs — stdout is for the brief.

// CRITICAL: maxTokens = 16000 for extract_wisdom AND merge calls.

// CRITICAL: chunkTranscript() — split on "\n\n**[" (double newline), NOT "\n**[".
//   transcribe.mjs separates turns with \n\n**[timestamp] Speaker N:** text
//   Using "\n**[" works as a substring but splits after the first \n, leaving
//   a blank line at the start of every subsequent chunk.

// CRITICAL: chunkTranscript() — use lastTurn >= 0, NOT > 0.
//   A turn boundary at position 0 of the slice is valid.
//   lastTurn > 0 would fall back to a hard char split, breaking mid-turn.

// CRITICAL: Chunk extractions run in parallel via Promise.all() — not serially.

// CRITICAL: mergeChunks() short-circuits if only 1 chunk — no merge call needed.

// CRITICAL: Write file BEFORE process.stdout.write() — file is the durable artifact.
//   writeFileSync(`${transcriptId}-output.md`, brief, "utf-8");
//   process.stdout.write(brief);

// CRITICAL: Supabase uses a two-step insert+update pattern.
//   Insert status="generating" before API calls so crashes leave a visible row.
//   Update to status="complete" with output_markdown after generation.

// CRITICAL: Supabase insert uses SUPABASE_SECRET_KEY (service role) — bypasses RLS.
//   Do NOT use the publishable key for server-side inserts.
```

### Files Being Changed

```
podcast-brief/
├── scripts/
│   └── generate-brief.mjs     ← NEW
├── prompts/
│   └── extract_wisdom.md       (existing — read at runtime)
├── transcripts/
│   └── arthur-c-brooks-are-we-happy-yet-2026-03-12.md  (existing — use as test input)
└── .env.example               ← MODIFIED (add OPENAI_API_KEY= placeholder)
```

---

## Implementation Blueprint

### Key Pseudocode

```js
// scripts/generate-brief.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { createClient } from "@supabase/supabase-js";

// Exit codes:
// 0 — success
// 1 — general error (missing args, missing files, API failure, etc.)
// 2 — brief already exists for this (profile_id, input_url) — HTTP wrapper maps to 409

// ── node version check ────────────────────────────────────────────────────────
if (parseInt(process.versions.node) < 18) {
  console.error("Error: Node 18+ required");
  process.exit(1);
}

// ── env checks ────────────────────────────────────────────────────────────────
for (const key of ["OPENAI_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ── arg checks ────────────────────────────────────────────────────────────────
// NOTE: episodeDescription must always be passed (use "" as placeholder).
//   profileId is the 5th positional arg — omitting description shifts it to 4th.
const [transcriptId, transcriptPath, episodeTitle = "Unknown Episode", episodeDescription = "", profileId] = process.argv.slice(2);
if (!transcriptId || !transcriptPath || !profileId) {
  console.error('Usage: node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> <transcript.md> "Episode Title" "Description" <profileId>');
  console.error('       Use "" for Description if not available — do not skip it.');
  process.exit(1);
}
if (!transcriptPath.endsWith(".md")) {
  console.error("Error: transcript must be a .md file");
  process.exit(1);
}
if (!existsSync(transcriptPath)) {
  console.error(`Error: file not found: ${transcriptPath}`);
  process.exit(1);
}

// ── load prompt ───────────────────────────────────────────────────────────────
const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../prompts/extract_wisdom.md");
if (!existsSync(promptPath)) {
  console.error(`Error: prompt file not found: ${promptPath}`);
  process.exit(1);
}
const SYSTEM = readFileSync(promptPath, "utf-8");

// ── load transcript ───────────────────────────────────────────────────────────
const transcript = readFileSync(transcriptPath, "utf-8");

// ── supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// ── callOpenAI ────────────────────────────────────────────────────────────────
async function callOpenAI(system, user, { maxTokens = 16000 } = {}) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI error ${res.status}: ${err.error?.message ?? "unknown"}`);
  }
  const data = await res.json();
  if (!data.choices?.length) throw new Error(`OpenAI returned no choices: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

// ── chunking ──────────────────────────────────────────────────────────────────
const CHUNK_CHAR_SIZE = 400_000; // ~100K tokens, leaves room for system prompt + output

function chunkTranscript(text) {
  if (text.length <= CHUNK_CHAR_SIZE) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_CHAR_SIZE) { chunks.push(remaining); break; }
    const slice = remaining.slice(0, CHUNK_CHAR_SIZE);
    const lastTurn = slice.lastIndexOf("\n\n**["); // turns are separated by \n\n in transcribe.mjs
    if (lastTurn < 0) console.error(`  Warning: no turn boundary found in chunk ${chunks.length + 1}, splitting at char limit`);
    const splitAt = lastTurn >= 0 ? lastTurn : CHUNK_CHAR_SIZE;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// ── extraction ────────────────────────────────────────────────────────────────
async function extractChunk(chunkText, index, total) {
  const label = total > 1 ? ` (chunk ${index + 1}/${total})` : "";
  console.error(`  Extracting${label}...`);
  const userContent = `Episode title: ${episodeTitle}\nDescription: ${episodeDescription}\n\nTranscript${total > 1 ? ` segment ${index + 1} of ${total}` : ""}:\n${chunkText}`;
  return callOpenAI(SYSTEM, userContent);
}

async function mergeChunks(briefs) {
  if (briefs.length === 1) return briefs[0]; // short-circuit — no merge needed
  console.error(`  Merging ${briefs.length} chunk briefs...`);
  const MERGE_SYSTEM = `You are combining extract_wisdom briefs from ${briefs.length} consecutive segments of the same podcast episode into one final brief.
Output the same Markdown sections (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS).
Deduplicate across segments. No repeated ideas, quotes, or references. Keep the best items from all segments.`;
  const userContent = briefs.map((b, i) => `--- Segment ${i + 1} ---\n${b}`).join("\n\n");
  return callOpenAI(MERGE_SYSTEM, userContent, { maxTokens: 16000 });
}

// ── main ──────────────────────────────────────────────────────────────────────
try {
  console.error("Generating brief...");

  // 409 check — if a complete or in-progress brief already exists, do not generate
  // Frontend should catch this first via direct Supabase query, but backend is authoritative
  const { data: existing } = await supabase
    .from("briefs")
    .select("id, status")
    .eq("input_url", transcriptId)
    .eq("profile_id", profileId)
    .in("status", ["complete", "generating"])
    .maybeSingle();
  if (existing) {
    console.error(`Brief already exists for this episode (status: ${existing.status}) — skipping generation`);
    process.exit(2); // HTTP wrapper maps exit code 2 → 409
  }

  // insert generating row before API calls so crashes leave a visible row
  const { data: briefRow, error: insertError } = await supabase
    .from("briefs")
    .insert({ profile_id: profileId, input_url: transcriptId, status: "generating" })
    .select("id")
    .single();
  if (insertError) throw new Error(`Supabase insert failed: ${insertError.message}`);
  const briefId = briefRow.id;

  const chunks = chunkTranscript(transcript);
  if (chunks.length > 1) console.error(`  → ${chunks.length} chunks`);

  const chunkBriefs = await Promise.all(chunks.map((chunk, i) => extractChunk(chunk, i, chunks.length)));
  const brief = await mergeChunks(chunkBriefs);

  // write file first (durable), then stdout
  const outputFile = `${transcriptId}-output.md`;
  writeFileSync(outputFile, brief, "utf-8");
  console.error(`✓ Brief written to ${outputFile}`);
  process.stdout.write(brief);

  // update brief row to complete
  console.error("  Saving to Supabase...");
  const { error: updateError } = await supabase
    .from("briefs")
    .update({ output_markdown: brief, status: "complete", completed_at: new Date().toISOString() })
    .eq("id", briefId);
  if (updateError) throw new Error(`Supabase update failed: ${updateError.message}`);
  console.error("✓ Saved to briefs table");
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

### Tasks

```yaml
Task 1 — Add OPENAI_API_KEY to .env.example:
  ADD line: OPENAI_API_KEY=

Task 2 — Create scripts/generate-brief.mjs:
  Implement exactly as pseudocode above.
  No dotenv import — run with node --env-file=.env.local
  All imports at top.
```

---

## Validation Loop

```bash
# 1. Missing arg guard
node --env-file=.env.local scripts/generate-brief.mjs
# Expected: usage message (including note about "" placeholder), exit 1

# 2. Wrong extension guard
node --env-file=.env.local scripts/generate-brief.mjs <uuid> transcripts/foo.json "Title" "" <profileId>
# Expected: "Error: transcript must be a .md file", exit 1

# 3. Missing env var guard (isolate exactly one var)
env -i OPENAI_API_KEY="" node --env-file=.env.local scripts/generate-brief.mjs <uuid> transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Title" "" <profileId>
# Expected: "Missing required env var: OPENAI_API_KEY", exit 1

# 4. End-to-end run
node --env-file=.env.local scripts/generate-brief.mjs \
  <transcriptId-from-supabase> \
  transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md \
  "Are We Happy Yet?" \
  "Arthur C. Brooks on happiness research." \
  <profileId>
# Expected: progress to stderr, {transcriptId}-output.md written,
#           markdown brief to stdout, briefs row with status=complete

# 5. Inspect output
cat <transcriptId>-output.md
# Expected: all extract_wisdom sections present, no "undefined" or "[object Object]"

# 6. 409 check — run the same command again after a successful run
node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Are We Happy Yet?" "Arthur C. Brooks on happiness research." <profileId>
# Expected: "Brief already exists..." logged, exit code 2, zero AI calls made
echo $?  # → 2

# 7. Simulate chunking — temporarily set CHUNK_CHAR_SIZE = 500, run again
# Expected: "→ N chunks" logged, merge step runs, output still has all sections

# 8. Pipe test
node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Are We Happy Yet?" "" <profileId> > /tmp/piped.md
diff /tmp/piped.md <transcriptId>-output.md
# Expected: no diff
```

## Anti-Patterns to Avoid

- Do NOT hardcode the system prompt — read from `prompts/extract_wisdom.md` at runtime
- Do NOT use `response_format: { type: "json_object" }` — output is plain Markdown
- Do NOT set maxTokens below 8000 — extract_wisdom requests many items
- Do NOT resolve prompt path with `process.cwd()` — use `import.meta.url`
- Do NOT split on `"\n**["` — use `"\n\n**["` to match transcribe.mjs turn format
- Do NOT use `lastTurn > 0` in chunkTranscript — use `lastTurn >= 0`
- Do NOT run chunk extractions serially — use `Promise.all()`
- Do NOT skip the `briefs.length === 1` short-circuit in mergeChunks
- Do NOT use `import "dotenv/config"` — use `node --env-file=.env.local`
- Do NOT use `require()` — this is `.mjs`, ESM only
- Do NOT use `console.log()` for progress — use `console.error()` to keep stdout clean
- Do NOT use the publishable Supabase key for inserts — use `SUPABASE_SECRET_KEY`
- Do NOT name the output file `brief-output.md` — use `{transcriptId}-output.md`
- Do NOT write stdout before the file — file is the durable artifact, write it first
- Do NOT insert directly with `status: "complete"` — insert `status: "generating"` first, then update
- Do NOT skip the `data.choices?.length` guard in callOpenAI — a 200 with empty choices throws a cryptic TypeError
- Do NOT omit `"Description"` arg — use `""` as placeholder; skipping it shifts profileId to wrong position
- Do NOT query idempotency check by `input_url` alone — must also filter by `profile_id` or you'll reuse another user's brief
