# Plan A: Transcript → OpenAI Extraction

## Goal

A standalone Node.js script (`scripts/generate-brief.mjs`) that reads a `.md` transcript, loads the system prompt from `prompts/extract_wisdom.md`, and makes **one OpenAI API call** — outputting the raw Markdown response directly. No JSON, no parsing, no assembly.

**Branch:** `brief-a-extract`
**Prerequisite:** None — this is the foundation.

## Why

- Minimal surface area: the prompt (`prompts/extract_wisdom.md`) does all the heavy lifting
- No speaker name attribution on quotes — avoids any risk of misattributing words to real people
- Subsequent plans (B, C, D) build on this script

## What

```bash
node --env-file=.env.local scripts/generate-brief.mjs path/to/transcript.md "Episode Title" "Episode description"
# → prints markdown brief to stdout
# → writes brief-output.md in the current working directory
```

**Note:** `brief-output.md` is written relative to `process.cwd()`. Run from the repo root.

### Success Criteria

- [ ] Script runs end-to-end on `transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md` without error
- [ ] Output contains the sections defined in `prompts/extract_wisdom.md` (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS)
- [ ] Quotes have no speaker attribution (anonymous transcript — no names to attribute)
- [ ] Script exits with a clear message if `OPENAI_API_KEY` is missing
- [ ] Script exits with a clear message if transcript path is missing, wrong extension, or not found
- [ ] Script exits with a clear message if `prompts/extract_wisdom.md` is not found
- [ ] `brief-output.md` is written on completion
- [ ] Script warns (stderr) if transcript exceeds ~512K characters (approaching gpt-4o's 128K token limit)

---

## All Needed Context

### Prompt File

`prompts/extract_wisdom.md` — loaded at runtime via `readFileSync`. It already contains full instructions including output format. The script passes it verbatim as the system message.

The prompt says "Include the name of the speaker of the quote at the end" — since this transcript uses anonymous speaker labels (Speaker 0, Speaker 1), **no speaker attribution is needed**. Do not modify the prompt file; the model will simply omit attribution when names aren't present.

### Transcript Input Format

Markdown (`.md`) only. Speaker turns formatted as:
```
**[00:00:04] Speaker 0:** I've often thought about happiness...
**[00:00:14] Speaker 1:** That's really interesting. Tell me more...
```

No name inference — speakers stay as `Speaker N` in the transcript.

### Environment Variables

```bash
OPENAI_API_KEY   # must be set in .env.local
```

Script is run with `node --env-file=.env.local` — no `dotenv` import needed.

### No New Dependencies

Only Node.js built-ins (`fs`) and native `fetch` (Node 18+).

### Documentation & References

```yaml
- file: scripts/transcribe.mjs
  why: Pattern for ESM script structure, arg parsing, env checking
  note: transcribe.mjs uses console.log() for progress — this script uses console.error()
        instead, to keep stdout clean for piping.

- file: prompts/extract_wisdom.md
  why: System prompt — read from disk at runtime, passed verbatim to OpenAI
```

### Known Gotchas

```js
// CRITICAL: Run with `node --env-file=.env.local` — no dotenv import.

// CRITICAL: All imports must be at the top — ESM imports are static.

// CRITICAL: callOpenAI() must check res.ok before reading body.
// On errors, data.choices will be undefined → TypeError.

// CRITICAL: Use console.error() for ALL progress logs — stdout is reserved
// for the brief output so piping works: node ... generate-brief.mjs ... > output.md
// NOTE: transcribe.mjs uses console.log() — this script intentionally diverges.

// CRITICAL: process.stdout.write(brief) and writeFileSync("brief-output.md", brief)
// must write identical content. Do NOT add a leading "\n" to one but not the other.

// CRITICAL: maxTokens must be high (16000) — the extract_wisdom prompt requests
// 20-50 IDEAS, 10-20 INSIGHTS, 15-30 QUOTES, etc. 4000 tokens will truncate output.

// CRITICAL: Warn if transcript is large — transcript.length > 512_000 characters
// (~128K tokens, gpt-4o's full context window). Warning only — Plan B adds chunking.

// CRITICAL: Resolve the prompt path relative to the script file, not process.cwd().
// Use: new URL('../prompts/extract_wisdom.md', import.meta.url)
// Otherwise the script breaks when run from a different directory.
```

### Current Codebase Tree

```
podcast-brief/
├── scripts/
│   └── transcribe.mjs
├── prompts/
│   └── extract_wisdom.md       (existing)
├── transcripts/
│   └── arthur-c-brooks-are-we-happy-yet-2026-03-12.md  (existing)
├── .env.example
└── package.json
```

### Desired Codebase Tree

```
podcast-brief/
├── scripts/
│   ├── transcribe.mjs
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

// No dotenv import — run with: node --env-file=.env.local scripts/generate-brief.mjs

// ── env + arg checks ──────────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing required env var: OPENAI_API_KEY");
  process.exit(1);
}

const [transcriptPath, episodeTitle = "Unknown Episode", episodeDescription = ""] = process.argv.slice(2);
if (!transcriptPath) {
  console.error('Usage: node --env-file=.env.local scripts/generate-brief.mjs <transcript.md> "Episode Title" "Description"');
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
if (transcript.length > 512_000) {
  console.error(`Warning: transcript is ${transcript.length} chars (~${Math.round(transcript.length / 4000)}K tokens) — at or beyond gpt-4o's 128K context limit. This call may fail. Plan B adds chunking.`);
}

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
  return (await res.json()).choices[0].message.content;
}

// ── extraction ────────────────────────────────────────────────────────────────
const userContent = `Episode title: ${episodeTitle}\nDescription: ${episodeDescription}\n\nTranscript:\n${transcript}`;

try {
  console.error("Extracting wisdom from transcript...");
  const brief = await callOpenAI(SYSTEM, userContent);

  process.stdout.write(brief);
  writeFileSync("brief-output.md", brief, "utf-8");
  console.error("✓ Brief written to brief-output.md");
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

### Tasks

```yaml
Task 1 — Add OPENAI_API_KEY to .env.example:
  OPEN: .env.example
  ADD line: OPENAI_API_KEY=
  Also verify it exists in .env.local — if not, note it needs a real key.

Task 2 — Create scripts/generate-brief.mjs:
  Implement exactly as pseudocode above.
  No dotenv import — script is run with node --env-file=.env.local
  All imports at top.

Task 3 — Verify Node version supports --env-file and native fetch:
  RUN: node --version
  Expected: v18+ (fetch and --env-file are both Node 18+)
```

---

## Validation Loop

```bash
# 1. Missing arg guard
node --env-file=.env.local scripts/generate-brief.mjs
# Expected: usage message, exit 1

# 2. Wrong extension guard
node --env-file=.env.local scripts/generate-brief.mjs transcripts/foo.json "Title"
# Expected: "Error: transcript must be a .md file"

# 3. Missing env var guard
OPENAI_API_KEY="" node scripts/generate-brief.mjs transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Title"
# Expected: "Missing required env var: OPENAI_API_KEY"

# 4. End-to-end run
node --env-file=.env.local scripts/generate-brief.mjs transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Are We Happy Yet?" "Arthur C. Brooks on happiness research."
# Expected: "Extracting wisdom..." to stderr, markdown brief to stdout, brief-output.md written

# 5. Inspect output
cat brief-output.md
# Expected:
#   - Sections from extract_wisdom.md present (SUMMARY, IDEAS, INSIGHTS, QUOTES, etc.)
#   - No "[object Object]" or "undefined" in output
#   - Quotes have no speaker attribution (anonymous transcript)
#   - stdout and brief-output.md contents are identical

# 6. Pipe test (stdout and file must match)
node --env-file=.env.local scripts/generate-brief.mjs transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Are We Happy Yet?" > /tmp/piped.md
diff /tmp/piped.md brief-output.md
# Expected: no diff
```

## Anti-Patterns to Avoid

- Do NOT hardcode the system prompt — read it from `prompts/extract_wisdom.md` at runtime
- Do NOT use `response_format: { type: "json_object" }` — the prompt outputs plain Markdown
- Do NOT set `maxTokens` below 8000 — the prompt requests 20-50 ideas, 15-30 quotes, etc. and will be truncated
- Do NOT resolve the prompt path with `process.cwd()` — use `import.meta.url` so the script works from any directory
- Do NOT import `libs/gpt.js` — wrong model, Next.js module
- Do NOT use `import "dotenv/config"` — use `node --env-file=.env.local`
- Do NOT use `require()` — this is `.mjs`, ESM only
- Do NOT use `console.log()` for progress — pollutes stdout; use `console.error()`
