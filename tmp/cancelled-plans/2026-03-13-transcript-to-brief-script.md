# Plan: Transcript → Brief Generation Script

## Goal

A standalone Node.js script (`scripts/generate-brief.mjs`) that reads a speaker-attributed transcript file and produces a formatted Markdown brief. No DB, no web server — just a local script you can run and iterate on.

## Why

- This is the core product value: turning a transcript into a useful brief
- Script-first lets us iterate on prompt quality and pipeline design before wiring up the full async worker
- Stays runnable locally as a debugging/testing tool forever

## What

```bash
node scripts/generate-brief.mjs path/to/transcript.md "Episode Title" "Episode description..."
# → writes brief to stdout and brief-output.md
```

Input: a Markdown transcript file with `**[HH:MM:SS] Speaker N:** text` formatting, plus episode title and description passed as CLI args.
Output: Markdown brief with 5 key ideas, 10 quotes, references with URLs, 3 questions.

### Success Criteria

- [ ] Script runs end-to-end on `scripts/sample-transcript.md` without error
- [ ] Output includes all 5 sections (ideas, quotes, references, questions, assembled Markdown)
  - Note: quotes are anonymous
- [ ] References have real URLs (found by Browserbase, not hallucinated)
- [ ] References that are "too common" or fail validation are skipped cleanly
- [ ] Script exits with a clear message if any env var is missing
- [ ] `brief-output.md` is written after completion

---

## All Needed Context

### Documentation & References

```yaml
- url: https://docs.browserbase.com/introduction/playwright
  why: How to create a session, connect via CDP, open multiple pages from one context

- file: libs/gpt.js
  why: Pattern reference only — do NOT import this file. It uses gpt-4 without JSON mode.
       The script reimplements callOpenAI() directly using fetch().

- file: .claude-instructions.md
  why: Project coding standards — ESM conventions, env var checking patterns.
```

### Transcript Input Format

**Markdown** (`.md`) — the only supported format. Speaker turns formatted as:
```
**[00:00:04] Speaker 0:** I've often thought about happiness...
**[00:00:14] Speaker 1:** That's really interesting. Tell me more...
**[00:00:33] Speaker 0:** Well, the research shows...
```

Speakers are numbered (`Speaker 0`, `Speaker 1`, etc.) — not named. The script resolves real names via LLM inference in Step 1 (see below).

### Token Budget & Chunking

GPT-4o context window: **128K tokens**. A typical full-episode transcript (~50K tokens) fits in one call. Longer transcripts are split into **120K-token chunks** and processed in parallel, then merged in a single final call.

**Chunking strategy (no RAG, pure prompting):**
1. Split transcript text into chunks of `CHUNK_SIZE = 120_000 * 4` characters (~120K tokens) at line boundaries (split on `\n**[` to avoid breaking mid-turn).
2. Run the same extraction prompt on each chunk in parallel — each returns its own `{ speakerMap, ideas, quotes, references, questions }`.
3. Feed all chunk outputs to a single **merge call** with a prompt like: _"You have N sets of extracted podcast brief data from consecutive chunks of the same episode. Combine them into one coherent brief: pick the best 5 ideas (no duplicates), best 10 quotes (no duplicates), union of references, best 3 questions."_
4. The merge call output is the final extracted object used by Steps 2–4.

Speaker inference happens on the **first chunk only** (speakers are established early in conversations). The speakerMap from chunk 0 is injected into subsequent chunk prompts and the merge prompt.

**Cost per episode (GPT-4o at $2.50/1M input, $10/1M output):**

| Scenario | Chunks | Step 1 cost | Merge cost | Steps 2–3 | Total |
|----------|--------|-------------|------------|-----------|-------|
| Typical (~50K tokens) | 1 | ~$0.155 | — | ~$0.030 | **~$0.19** |
| Long (~150K tokens) | 2 | ~$0.375 | ~$0.030 | ~$0.030 | **~$0.44** |
| Very long (~250K tokens) | 3 | ~$0.625 | ~$0.045 | ~$0.030 | **~$0.70** |

At 1,000 episodes/month (typical) → ~$190/mo. GPT-4o mini is ~16× cheaper if quality holds.

### Environment Variables Required

```bash
OPENAI_API_KEY   # already exists in .env.local
EXA_API_KEY      # NEW — from exa.ai dashboard
```

Script fails fast with a clear error if any are missing. Add placeholder comment lines to `.env.local`.

### New Dependencies (all devDependencies — script-only, not used by Next.js app)

```bash
npm install --save-dev exa-js dotenv
```

### Exa Search Architecture

Exa provides a clean REST API for neural search. For each reference, call `POST https://api.exa.ai/search` with the generated query. Returns ranked results with URL and title — no browser needed.

```js
async function exaSearch(query) {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": process.env.EXA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, numResults: 1 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = data.results?.[0];
  return result ? { url: result.url, title: result.title } : null;
}
```

Run all reference searches in parallel via `batchedAll` (batch size 5 to be safe with rate limits).

### Current Codebase Tree

```
podcast-brief/
├── libs/
│   └── gpt.js
├── scripts/                    # does not exist yet
└── package.json
```

### Desired Codebase Tree

```
podcast-brief/
├── libs/
│   └── gpt.js
├── scripts/
│   ├── generate-brief.mjs     # ← NEW
│   └── sample-transcript.md   # ← NEW (for local testing, Speaker N format)
└── package.json               # ← MODIFIED (3 new devDependencies)
```

### Known Gotchas

```js
// CRITICAL: Do NOT import libs/gpt.js — it uses gpt-4, no response_format support,
// and is a Next.js module. Reimplement callOpenAI() with fetch() in the script.

// CRITICAL: dotenv reads .env by default, NOT .env.local
// Use: import { config } from "dotenv"; config({ path: ".env.local" });
// Do NOT use import "dotenv/config" — it reads the wrong file.

// CRITICAL: All imports must be at the top of the .mjs file before any executable code.
// ESM imports are hoisted — you cannot import mid-script.

// CRITICAL: callOpenAI() must check res.ok before reading response body.
// On rate limits or server errors, data.choices will be undefined → TypeError.

// CRITICAL: Always wrap JSON.parse() on LLM output in try-catch.
// json_object mode reduces but does not eliminate malformed JSON risk.

// CRITICAL: Set max_tokens per call site to prevent silent truncation:
//   Step 1 per chunk (extraction): 3000
//   Step 1 merge: 3000
//   Step 2 (search query per ref): 150
//   Step 3 (URL validation per ref): 100

// CRITICAL: URL validation via LLM cannot detect paywalls or broken links —
// it only sees the URL string and page title. Frame the prompt honestly as
// a relevance check: "Does this URL appear to be a useful, relevant resource
// for this reference, based on the URL and page title?"

// CRITICAL: All console.log() calls in the main block must be console.error() —
// stdout is reserved for the brief output so piping works cleanly:
// node generate-brief.mjs transcript.md "Title" "Desc" > output.md
// console.log() in the main block would pollute the piped output.

// CRITICAL: Guard all extracted fields with ?? [] before passing downstream:
//   const ideas = extracted.ideas ?? [];
// The LLM returns valid JSON but may omit a field entirely if the transcript
// has insufficient content. Without the guard, downstream .map() throws TypeError.

// CRITICAL: chunkTranscript() uses lastTurn >= 0, NOT lastTurn > 0.
// A turn boundary at position 0 of the slice is valid. lastTurn > 0 would
// incorrectly fall back to a hard character-split, breaking the turn boundary guarantee.

// CRITICAL: existsSync is imported at the top with readFileSync/writeFileSync.
// Do NOT add a second import statement mid-script — ESM imports are static and
// must be at the top. The prior review's inline "import { existsSync }" comment
// in the main block was wrong; existsSync is in the top-level fs import.

// CRITICAL: config() path uses import.meta.url, not a relative string.
//   WRONG:  config({ path: ".env.local" })      ← breaks if run from subdirectory
//   RIGHT:  config({ path: new URL("../.env.local", import.meta.url).pathname })
// This makes the script runnable from any directory.

// CRITICAL: callOpenAI() 429 on the FINAL retry must throw explicitly.
// Without this, the loop exits and the function returns undefined, causing
// a misleading "Failed to parse JSON" error rather than "rate limit exceeded".
```

---

## Implementation Blueprint

### Data Models

```js
// Step 1 per-chunk LLM output (JSON parsed):
{
  speakerMap: { [speakerLabel: string]: string },    // only meaningful from chunk 0
  ideas: [{ title: string, description: string }],  // up to 5 per chunk
  quotes: [{ text: string, speaker: string }],       // up to 10 per chunk
  references: [{ name: string, context: string }],   // all named entities in this chunk
  questions: [string]                                 // up to 3 per chunk
}

// Step 1 merge LLM output (JSON parsed) — same shape, final counts enforced:
{
  ideas: [{ title: string, description: string }],  // exactly 5
  quotes: [{ text: string, speaker: string }],       // exactly 10
  references: [{ name: string, context: string }],   // deduped union
  questions: [string]                                 // exactly 3
}

// Step 2 — Exa result per reference:
{ url: string, title: string } | null

// Final resolved reference:
{ name: string, context: string, url: string | null }
```

### Full Script Pseudocode

```js
// scripts/generate-brief.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";
import { config } from "dotenv";

// Resolve .env.local relative to this script's location (not process.cwd()).
// Allows running the script from any directory: node scripts/generate-brief.mjs ...
config({ path: new URL("../.env.local", import.meta.url).pathname });

// ── env check ─────────────────────────────────────────────────────────────────

function checkEnv() {
  for (const key of ["OPENAI_API_KEY", "EXA_API_KEY"]) {
    if (!process.env[key]) {
      console.error(`Missing required env var: ${key}`);
      process.exit(1);
    }
  }
}

// ── OpenAI helper ─────────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userContent, { jsonMode = false, maxTokens = 1000, retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
        ...(jsonMode && { response_format: { type: "json_object" } }),
      }),
    });

    // Retry on 429 rate limit with exponential backoff
    if (res.status === 429) {
      if (attempt < retries) {
        const wait = 2 ** attempt * 1000;
        console.error(`  OpenAI rate limited — retrying in ${wait / 1000}s (attempt ${attempt}/${retries})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // Final attempt also 429 — throw clearly rather than falling off the loop
      throw new Error(`OpenAI rate limit: exceeded ${retries} retries`);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OpenAI error ${res.status}: ${err.error?.message ?? "unknown"}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }
}

// ── batched Promise.all ───────────────────────────────────────────────────────

async function batchedAll(items, fn, batchSize = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    results.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)));
  }
  return results;
}

// ── step 1: chunking + extraction + merge ────────────────────────────────────

// 480K chars ≈ 120K tokens. GPT-4o window is 128K. Leaves ~8K tokens for
// system prompt + episode metadata prefix + safety margin. Do NOT increase
// this without accounting for prompt overhead (~500–700 tokens).
const CHUNK_CHAR_SIZE = 120_000 * 4;

function chunkTranscript(text) {
  if (text.length <= CHUNK_CHAR_SIZE) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_CHAR_SIZE) {
      chunks.push(remaining);
      break;
    }
    // Split at last turn boundary before limit to avoid breaking mid-turn
    const slice = remaining.slice(0, CHUNK_CHAR_SIZE);
    const lastTurn = slice.lastIndexOf("\n**[");
    // Use >= 0 (not > 0): a boundary at position 0 is still valid
    if (lastTurn < 0) {
      console.warn(`  Warning: no turn boundary found in chunk ${chunks.length + 1}; splitting at character limit`);
    }
    const splitAt = lastTurn >= 0 ? lastTurn : CHUNK_CHAR_SIZE;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

const EXTRACTION_SYSTEM = (speakerMapHint = null) => `
You are an expert podcast analyst. The transcript uses generic speaker labels (Speaker 0, Speaker 1, etc.).
${speakerMapHint
  ? `Speaker identities (already resolved): ${JSON.stringify(speakerMapHint)}`
  : `FIRST, infer each speaker's real name from conversational patterns, self-introductions, and episode metadata. Return inferences in "speakerMap".`
}

Return valid JSON:
{
  "speakerMap": { "Speaker 0": "Real Name", ... },
  "ideas": [ { "title": string, "description": string } ],
  "quotes": [ { "text": string, "speaker": string } ],
  "references": [ { "name": string, "context": string } ],
  "questions": [ string ]
}

RULES:
- speakerMap: infer from context. Use episode title/description to anchor names. Fallback: "Host"/"Guest".
- ideas: up to 5. Key insights a non-listener finds valuable. 2-3 sentence description each.
- quotes: up to 10. Verbatim from transcript. Use real name from speakerMap, not "Speaker N".
- references: ALL named entities with identity outside this conversation (books, papers, named concepts,
    people, films, tools, orgs discussed with a specific angle). NOT generic nouns or passing mentions.
    Include context: what was specifically said about this reference.
- questions: up to 3. Open-ended. Valuable without having heard the episode.
`;

async function extractChunk(chunkText, episodeTitle, episodeDescription, speakerMapHint) {
  const system = EXTRACTION_SYSTEM(speakerMapHint);
  const userContent = `Episode title: ${episodeTitle}\nDescription: ${episodeDescription}\n\nTranscript segment:\n${chunkText}`;
  const raw = await callOpenAI(system, userContent, { jsonMode: true, maxTokens: 3000 });
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse chunk extraction as JSON:\n${raw}`);
  }
}

async function mergeExtractions(chunkResults) {
  if (chunkResults.length === 1) return chunkResults[0];

  const system = `
You are combining extracted data from ${chunkResults.length} consecutive segments of the same podcast episode.
Produce one final brief with the best content across all segments.

Return valid JSON:
{
  "ideas": [ { "title": string, "description": string } ],
  "quotes": [ { "text": string, "speaker": string } ],
  "references": [ { "name": string, "context": string } ],
  "questions": [ string ]
}

RULES:
- ideas: exactly 5. Pick the most insightful across all segments. No duplicates or near-duplicates. Keep descriptions under 50 words each.
- quotes: exactly 10. Most memorable/striking across all segments. No duplicates.
- references: union of all references, deduplicated by name. Merge context if the same entity appears in multiple segments. Keep context under 30 words each. Cap at 20 most specific/useful — drop generic or passing mentions if over the cap.
- questions: exactly 3. Most thought-provoking across all segments.
`;
  const userContent = chunkResults
    .map((r, i) => `--- Segment ${i + 1} ---\n${JSON.stringify(r, null, 2)}`)
    .join("\n\n");

  const raw = await callOpenAI(system, userContent, { jsonMode: true, maxTokens: 3000 });
  try {
    const merged = JSON.parse(raw);
    // Re-attach speakerMap from chunk 0 for downstream use
    merged.speakerMap = chunkResults[0].speakerMap;
    return merged;
  } catch {
    throw new Error(`Failed to parse merge response as JSON:\n${raw}`);
  }
}

async function extractFromTranscript(transcript, episodeTitle, episodeDescription) {
  const chunks = chunkTranscript(transcript);
  if (chunks.length > 1) {
    console.error(`  → Transcript split into ${chunks.length} chunks of ~120K tokens each`);
  }

  // First chunk: infer speaker map
  const first = await extractChunk(chunks[0], episodeTitle, episodeDescription, null);
  const speakerMap = first.speakerMap ?? {};

  // Remaining chunks: inject resolved speakerMap
  const rest = await Promise.all(
    chunks.slice(1).map((chunk) => extractChunk(chunk, episodeTitle, episodeDescription, speakerMap))
  );

  return mergeExtractions([first, ...rest]);
}

// ── step 2: reference resolution via Exa ─────────────────────────────────────

async function exaSearch(query) {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": process.env.EXA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, numResults: 1 }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = data.results?.[0];
  return result ? { url: result.url, title: result.title } : null;
}

async function resolveReferences(references) {
  return batchedAll(references, async (ref) => {
    try {
      const result = await exaSearch(ref.name);
      return { ...ref, url: result?.url ?? null };
    } catch (e) {
      console.warn(`  Exa search failed for "${ref.name}": ${e.message}`);
      return { ...ref, url: null };
    }
  });
}

// ── step 4: assemble markdown ─────────────────────────────────────────────────

function assembleBrief({ ideas, quotes, questions }, validatedRefs) {
  const ideasMd = ideas
    .map((idea, i) => `${i + 1}. **${idea.title}** — ${idea.description}`)
    .join("\n");

  const quotesMd = quotes
    .map((q) => `> "${q.text}" — *${q.speaker}*`)
    .join("\n\n");

  const validRefs = validatedRefs.filter((r) => r.url);
  const refsMd = validRefs.length
    ? validRefs.map((r) => `- **${r.name}** — ${r.context} — [Link](${r.url})`).join("\n")
    : "_No specific references found._";

  const questionsMd = questions.map((q) => `- ${q}`).join("\n");

  return `# Podcast Brief

## 5 Key Ideas
${ideasMd}

## 10 Quotes
${quotesMd}

## References
${refsMd}

## 3 Questions to Sit With
${questionsMd}
`;
}

// ── main ──────────────────────────────────────────────────────────────────────

checkEnv();

const [transcriptPath, episodeTitle = "Unknown Episode", episodeDescription = ""] = process.argv.slice(2);
if (!transcriptPath) {
  console.error('Usage: node scripts/generate-brief.mjs <transcript.md> "<Episode Title>" "<Episode Description>"');
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

const transcript = readFileSync(transcriptPath, "utf-8");

console.error("Step 1: Inferring speakers + extracting ideas, quotes, references, questions...");
const extracted = await extractFromTranscript(transcript, episodeTitle, episodeDescription);
const ideas = extracted.ideas ?? [];
const quotes = extracted.quotes ?? [];
const references = extracted.references ?? [];
const questions = extracted.questions ?? [];
console.error(`  → Speaker map: ${JSON.stringify(extracted.speakerMap)}`);
console.error(`  → ${ideas.length} ideas, ${quotes.length} quotes, ${references.length} references, ${questions.length} questions`);

console.error("Step 2: Searching references via Exa...");
const resolved = await resolveReferences(references);
console.error(`  → ${resolved.filter((r) => r.url).length}/${resolved.length} found URLs`);

console.error("Step 3: Assembling brief...");
const brief = assembleBrief({ ideas, quotes, questions }, resolved);

process.stdout.write("\n" + brief);
writeFileSync("brief-output.md", brief, "utf-8");
console.error("\n✓ Brief written to brief-output.md");
```

---

### Tasks (in implementation order)

```yaml
Task 1 — Install dependencies:
  RUN: npm install --save-dev exa-js dotenv
  VERIFY: package.json devDependencies contains both packages

Task 2 — Create sample transcript:
  CREATE scripts/sample-transcript.md in the real transcript format.
  Use Speaker 0 / Speaker 1 labels (not names). Include at least:
  - one self-introduction or name-drop that lets the LLM infer identities
  - one notable quotable line
  - one named reference (book, concept, or paper)
  - enough substance (~15 turns) for the LLM to find 5 ideas and 3 questions.
  Example shape:
  **[00:00:04] Speaker 0:** Welcome back. I'm joined today by Arthur Brooks...
  **[00:00:10] Speaker 1:** Great to be here. I've been thinking about what you said last time...
  **[00:00:33] Speaker 0:** Your book "From Strength to Strength" argues that...

Task 3 — Create scripts/generate-brief.mjs:
  Implement exactly as pseudocode above. All imports at the top.
  config({ path: ".env.local" }) called before checkEnv().

Task 4 — Update .env.local:
  ADD one comment line (no real key):
    # EXA_API_KEY=
```

---

## Validation Loop

```bash
# 1. Confirm deps installed
node -e "import('@browserbasehq/sdk').then(() => console.log('ok'))"

# 2. Check env var guard (should exit with clear message, not a crash)
node scripts/generate-brief.mjs scripts/sample-transcript.md
# Expected (without env vars set): "Missing required env var: OPENAI_API_KEY"

# 3. Check .md format guard
node scripts/generate-brief.mjs scripts/sample-transcript.json
# Expected: "Error: transcript must be a .md file"

# 4. With all env vars set, run end-to-end:
node scripts/generate-brief.mjs scripts/sample-transcript.md "Sample Episode" "A conversation about happiness and resilience."
# Expected: step logs printed including speaker map, brief written to brief-output.md

# 5. Inspect output:
cat brief-output.md
# Expected: all 5 sections present, quotes attributed to real names (not "Speaker 0"),
#           no "undefined" or "[object Object]" in output
```

---

## Anti-Patterns to Avoid

- Do NOT import `libs/gpt.js` — wrong model, no JSON mode, Next.js module
- Do NOT use `import "dotenv/config"` — it reads `.env` not `.env.local`
- Do NOT place `import` statements after executable code — ESM imports must be at the top
- Do NOT use `require()` — this is `.mjs`, ESM only
- Do NOT install `exa-js` or `dotenv` as regular dependencies — they are `devDependencies`
- Do NOT use the `exa-js` SDK class — call the Exa REST API with `fetch()` directly (simpler, no ESM compatibility concerns)
- Do NOT accept `.json` or `.txt` transcript files — `.md` is the only format; exit with a clear error if a different extension is passed
- Do NOT make a separate API call for speaker inference — it is combined into the per-chunk extraction prompt (chunk 0 infers names; subsequent chunks receive the resolved speakerMap)
- Do NOT truncate long transcripts — chunk at ~120K token boundaries and merge outputs; truncation silently loses content from long episodes
- Do NOT split chunks mid-turn — always split on `\n**[` (turn boundaries) to avoid feeding the LLM a half-formed speaker turn
- Do NOT run chunk extractions serially — after chunk 0 resolves the speakerMap, remaining chunks run in parallel via `Promise.all`
