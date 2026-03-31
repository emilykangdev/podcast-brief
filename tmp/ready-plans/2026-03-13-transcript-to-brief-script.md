# Plan: Transcript → Brief Generation Script

## Goal

A standalone Node.js script (`scripts/generate-brief.mjs`) that reads a speaker-attributed transcript file and produces a formatted Markdown brief. No DB, no web server — just a local script you can run and iterate on.

## Why

- This is the core product value: turning a transcript into a useful brief
- Script-first lets us iterate on prompt quality and pipeline design before wiring up the full async worker
- Stays runnable locally as a debugging/testing tool forever

## What

```bash
node scripts/generate-brief.mjs path/to/transcript.json
# → writes brief to stdout and brief-output.md
```

Input: a JSON transcript file (array of speaker-attributed chunks).
Output: Markdown brief with 5 key ideas, 10 quotes, references with URLs, 3 questions.

### Success Criteria

- [ ] Script runs end-to-end on `scripts/sample-transcript.json` without error
- [ ] Output includes all 5 sections (ideas, quotes, references, questions, assembled Markdown)
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

The script accepts two formats detected by file extension:

**JSON** (`.json`) — array of speaker chunks:
```json
[
  { "speaker": "Host", "text": "Welcome back everyone...", "start": 0.0, "end": 4.2 },
  { "speaker": "Guest", "text": "Great to be here...", "start": 4.5, "end": 8.1 }
]
```

**Plain text** (`.txt`) — passed through as-is to the LLM.

### Environment Variables Required

```bash
OPENAI_API_KEY          # already exists in .env.local
BROWSERBASE_API_KEY     # NEW — from browserbase.com dashboard
BROWSERBASE_PROJECT_ID  # NEW — from browserbase.com dashboard
```

Script fails fast with a clear error if any are missing. Add placeholder comment lines to `.env.local`.

### New Dependencies (all devDependencies — script-only, not used by Next.js app)

```bash
npm install --save-dev @browserbasehq/sdk playwright-core dotenv
```

### Browserbase Session Architecture

**One session per episode, one page per reference (parallel).**

Creating one Browserbase session per reference would cost ~$185–200/month extra at 1,000 episodes/day (20 references each = 20,000 sessions/day vs. 1,000). The correct approach:

1. Create **one** Browserbase session per script run
2. Open **one new page per reference** from the same browser context
3. Run all page navigations in parallel via `Promise.all` (batched, see below)
4. Close the browser once in a `finally` block

Browserbase accounts have concurrency limits (e.g., 25 on Developer plan). Batch references in groups of **5** to stay safe:

```js
async function batchedPromiseAll(items, fn, batchSize = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}
```

### DuckDuckGo URL Extraction

DuckDuckGo result anchors use redirect hrefs like `//duckduckgo.com/l/?uddg=<encoded-url>`. Reading `anchor.href` (the DOM property) gives the resolved redirect URL, not the real destination. Extract and decode the actual URL:

```js
const rawHref = anchor.getAttribute("href") ?? "";
const url = rawHref.includes("uddg=")
  ? decodeURIComponent(new URL("https:" + rawHref).searchParams.get("uddg") ?? rawHref)
  : rawHref;
```

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
│   ├── generate-brief.mjs      # ← NEW
│   └── sample-transcript.json  # ← NEW (for local testing)
└── package.json                # ← MODIFIED (3 new devDependencies)
```

### Known Gotchas

```js
// CRITICAL: Do NOT import libs/gpt.js — it uses gpt-4, no response_format support,
// and is a Next.js module. Reimplement callOpenAI() with fetch() in the script.

// CRITICAL: Use @browserbasehq/sdk (NOT the deprecated "browserbase" npm package)

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
//   Step 1 (full extraction): 3000
//   Step 2 (search query per ref): 150
//   Step 3 (URL validation per ref): 100

// CRITICAL: URL validation via LLM cannot detect paywalls or broken links —
// it only sees the URL string and page title. Frame the prompt honestly as
// a relevance check: "Does this URL appear to be a useful, relevant resource
// for this reference, based on the URL and page title?"
```

---

## Implementation Blueprint

### Data Models

```js
// Step 1 LLM output (JSON parsed):
{
  ideas: [{ title: string, description: string }],  // exactly 5
  quotes: [{ text: string, speaker: string }],       // exactly 10
  references: [{ name: string, context: string }],   // all named entities, no URLs
  questions: [string]                                 // exactly 3
}

// Step 2a — per reference, LLM search decision:
{ skip: boolean, query: string }

// Step 2b — Browserbase result per reference:
{ url: string, title: string } | null

// Step 3 — URL validation LLM output:
{ valid: boolean }

// Final resolved reference:
{ name: string, context: string, url: string | null }
```

### Full Script Pseudocode

```js
// scripts/generate-brief.mjs
import { readFileSync, writeFileSync } from "fs";
import { config } from "dotenv";
import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";

config({ path: ".env.local" });

// ── env check ─────────────────────────────────────────────────────────────────

function checkEnv() {
  for (const key of ["OPENAI_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]) {
    if (!process.env[key]) {
      console.error(`Missing required env var: ${key}`);
      process.exit(1);
    }
  }
}

// ── OpenAI helper ─────────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userContent, { jsonMode = false, maxTokens = 1000 } = {}) {
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI error ${res.status}: ${err.error?.message ?? "unknown"}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ── batched Promise.all ───────────────────────────────────────────────────────

async function batchedAll(items, fn, batchSize = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    results.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)));
  }
  return results;
}

// ── step 1: LLM extraction ────────────────────────────────────────────────────

async function extractFromTranscript(transcript) {
  const system = `
You are an expert podcast analyst. Extract structured information from the transcript.
Return valid JSON with exactly this shape:
{
  "ideas": [ { "title": string, "description": string } ],
  "quotes": [ { "text": string, "speaker": string } ],
  "references": [ { "name": string, "context": string } ],
  "questions": [ string ]
}

RULES:
- ideas: exactly 5. Key insights a non-listener finds valuable. 2-3 sentence description each.
- quotes: exactly 10. Verbatim from transcript. Exact words, correct speaker name.
- references: ALL named entities with their own identity outside this conversation.
    Includes: books, papers, named concepts (e.g. "Dunbar's Number"), people, films, tools,
    organizations discussed with a specific angle. NOT generic nouns or passing brand mentions.
    Include context: what was specifically said about this reference.
- questions: exactly 3. Open-ended. Valuable without having heard the episode.
    Style: "How might you apply the concept of X..." / "What do you think about..."
`;
  const raw = await callOpenAI(system, transcript, { jsonMode: true, maxTokens: 3000 });
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse Step 1 LLM response as JSON:\n${raw}`);
  }
}

// ── step 2: reference resolution (shared browser session) ─────────────────────

async function resolveReferences(references) {
  // 2a: For each reference, LLM decides whether to search and generates a query
  const decisions = await batchedAll(references, async (ref) => {
    const raw = await callOpenAI(
      `Decide if a podcast reference warrants finding a specific link.
       Worth searching: there exists a specific resource (article, paper, book page, talk, docs)
       a curious person would actually want to read after hearing this discussed.
       Skip if: well-known entity with no specific angle (e.g. "Apple" the company,
       a famous person mentioned only in passing).
       Return JSON: { "skip": boolean, "query": string }
       query = targeted search string to find the specific resource.`,
      `Reference: ${ref.name}\nContext: ${ref.context}`,
      { jsonMode: true, maxTokens: 150 }
    );
    try {
      return { ref, ...JSON.parse(raw) };
    } catch {
      return { ref, skip: true, query: "" };
    }
  });

  const toSearch = decisions.filter((d) => !d.skip);
  if (toSearch.length === 0) return references.map((ref) => ({ ...ref, url: null }));

  // 2b: One Browserbase session, one page per reference, batched parallel
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const ctx = browser.contexts()[0];

  const searchResults = new Map(); // ref.name → { url, pageTitle } | null

  try {
    await batchedAll(toSearch, async ({ ref, query }) => {
      const page = await ctx.newPage();
      try {
        await page.goto(
          `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
          { waitUntil: "domcontentloaded" }
        );
        await page.waitForSelector('[data-testid="result"]', { timeout: 10000 });

        const result = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="result"]');
          if (!el) return null;
          const anchor = el.querySelector("a[href]");
          const heading = el.querySelector("h2");
          return {
            rawHref: anchor?.getAttribute("href") ?? "",
            title: heading?.textContent?.trim() ?? "",
          };
        });

        if (result) {
          // Decode DuckDuckGo redirect URL
          const url = result.rawHref.includes("uddg=")
            ? decodeURIComponent(
                new URL("https:" + result.rawHref).searchParams.get("uddg") ?? result.rawHref
              )
            : result.rawHref;
          searchResults.set(ref.name, { url, pageTitle: result.title });
        } else {
          searchResults.set(ref.name, null);
        }
      } catch (e) {
        console.warn(`  Search failed for "${ref.name}": ${e.message}`);
        searchResults.set(ref.name, null);
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }

  // Merge results back onto references
  return references.map((ref) => {
    const found = searchResults.get(ref.name);
    return found ? { ...ref, url: found.url, pageTitle: found.pageTitle } : { ...ref, url: null };
  });
}

// ── step 3: URL validation (relevance check) ──────────────────────────────────

async function validateReferences(refs) {
  return batchedAll(refs, async (ref) => {
    if (!ref.url) return ref;

    const raw = await callOpenAI(
      `Based only on the URL and page title, decide if this looks like a relevant,
       useful resource for the given reference. Not spam, not an unrelated page.
       Return JSON: { "valid": boolean }`,
      `Reference: ${ref.name}\nURL: ${ref.url}\nPage title: ${ref.pageTitle ?? "unknown"}`,
      { jsonMode: true, maxTokens: 100 }
    );

    try {
      const { valid } = JSON.parse(raw);
      return { ...ref, url: valid ? ref.url : null };
    } catch {
      return { ...ref, url: null }; // fail safe: drop on parse error
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

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  console.error("Usage: node scripts/generate-brief.mjs <transcript.json|transcript.txt>");
  process.exit(1);
}

const raw = readFileSync(transcriptPath, "utf-8");
const transcript = transcriptPath.endsWith(".json")
  ? JSON.parse(raw).map((c) => `${c.speaker}: ${c.text}`).join("\n")
  : raw;

console.log("Step 1: Extracting ideas, quotes, references, questions...");
const extracted = await extractFromTranscript(transcript);
console.log(
  `  → ${extracted.ideas.length} ideas, ${extracted.quotes.length} quotes, ` +
  `${extracted.references.length} references, ${extracted.questions.length} questions`
);

console.log("Step 2: Resolving reference URLs via Browserbase...");
const resolved = await resolveReferences(extracted.references);
console.log(`  → ${resolved.filter((r) => r.url).length}/${resolved.length} found URLs`);

console.log("Step 3: Validating URLs...");
const validated = await validateReferences(resolved);
console.log(`  → ${validated.filter((r) => r.url).length} passed validation`);

console.log("Step 4: Assembling brief...");
const brief = assembleBrief(extracted, validated);

process.stdout.write("\n" + brief);
writeFileSync("brief-output.md", brief, "utf-8");
console.error("\n✓ Brief written to brief-output.md");
```

---

### Tasks (in implementation order)

```yaml
Task 1 — Install dependencies:
  RUN: npm install --save-dev @browserbasehq/sdk playwright-core dotenv
  VERIFY: package.json devDependencies contains all three packages

Task 2 — Create sample transcript:
  CREATE scripts/sample-transcript.json with ~5 speaker chunks.
  Include at least one reference (e.g. a book title), one notable quote,
  and enough substance for the LLM to find 5 ideas and 3 questions.
  Example shape:
  [
    { "speaker": "Host", "text": "...", "start": 0.0, "end": 5.0 },
    { "speaker": "Guest", "text": "...", "start": 5.2, "end": 12.0 }
  ]

Task 3 — Create scripts/generate-brief.mjs:
  Implement exactly as pseudocode above. All imports at the top.
  config({ path: ".env.local" }) called before checkEnv().

Task 4 — Update .env.local:
  ADD two comment lines (no real keys):
    # BROWSERBASE_API_KEY=
    # BROWSERBASE_PROJECT_ID=
```

---

## Validation Loop

```bash
# 1. Confirm deps installed
node -e "import('@browserbasehq/sdk').then(() => console.log('ok'))"

# 2. Check env var guard (should exit with clear message, not a crash)
node scripts/generate-brief.mjs scripts/sample-transcript.json
# Expected (without env vars set): "Missing required env var: OPENAI_API_KEY"

# 3. With all env vars set, run end-to-end:
node scripts/generate-brief.mjs scripts/sample-transcript.json
# Expected: step logs printed, brief written to brief-output.md

# 4. Inspect output:
cat brief-output.md
# Expected: all 5 sections present, no "undefined" or "[object Object]" in output
```

---

## Anti-Patterns to Avoid

- Do NOT import `libs/gpt.js` — wrong model, no JSON mode, Next.js module
- Do NOT use the deprecated `browserbase` npm package — use `@browserbasehq/sdk`
- Do NOT create one Browserbase session per reference — one session per script run, one page per reference
- Do NOT use `import "dotenv/config"` — it reads `.env` not `.env.local`
- Do NOT place `import` statements after executable code — ESM imports must be at the top
- Do NOT use `require()` — this is `.mjs`, ESM only
- Do NOT install `@browserbasehq/sdk`, `playwright-core`, or `dotenv` as regular dependencies — they are `devDependencies`
- Do NOT read `anchor.href` (DOM property) for DuckDuckGo results — it resolves to a redirect; use `getAttribute("href")` and decode the `uddg` param
