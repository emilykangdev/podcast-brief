# Plan A: Transcript → Claude Extraction

## Goal

A standalone Node.js script (`scripts/generate-brief.mjs`) that reads a speaker-attributed `.md` transcript and makes **one Claude API call** to extract ideas, quotes, references, and questions — outputting raw Markdown. No chunking, no URL lookup, no assembly step. Just extraction.

**Branch:** `brief-a-extract`
**Prerequisite:** None — this is the foundation.

## Why

- This is the core product value: can Claude turn a transcript into useful structured content?
- Keep it minimal so prompt quality can be iterated on in isolation
- Subsequent plans (B, C, D) build on this script

## What

```bash
node scripts/generate-brief.mjs path/to/transcript.md "Episode Title" "Episode description"
# → prints extraction JSON + raw markdown to stdout
# → writes brief-output.md
```

### Success Criteria

- [ ] Script runs end-to-end on `scripts/sample-transcript.md` without error
- [ ] Output contains: ideas, quotes, references (names only), questions
- [ ] Speaker names are inferred from transcript context (not "Speaker 0")
- [ ] Script exits with a clear message if `OPENAI_API_KEY` or transcript path is missing
- [ ] `.md` format enforced — exits cleanly on other extensions
- [ ] `brief-output.md` written on completion

---

## All Needed Context

### Transcript Input Format

Markdown (`.md`) only. Speaker turns formatted as:
```
**[00:00:04] Speaker 0:** I've often thought about happiness...
**[00:00:14] Speaker 1:** That's really interesting. Tell me more...
```
Speakers are numbered, not named. Claude infers real names from context.

### Environment Variables

```bash
OPENAI_API_KEY   # already in .env.local
```

Script must fail fast with a clear error if missing.

### New Dependencies (devDependencies only)

```bash
npm install --save-dev dotenv
```

### Documentation & References

```yaml
- file: scripts/transcribe.mjs
  why: Pattern for ESM script structure, dotenv loading, env checking, arg parsing

- file: .claude-instructions.md
  why: Project coding conventions
```

### Known Gotchas

```js
// CRITICAL: dotenv reads .env by default, NOT .env.local
// Use: config({ path: new URL("../.env.local", import.meta.url).pathname })
// This makes the script runnable from any directory.

// CRITICAL: All imports must be at the top — ESM imports are static.

// CRITICAL: callOpenAI() must check res.ok before reading body.
// On errors, data.choices will be undefined → TypeError.

// CRITICAL: Always JSON.parse() LLM output in try-catch.
// json_object mode reduces but does not eliminate malformed JSON risk.

// CRITICAL: Use console.error() for all progress logs — stdout is reserved
// for the brief so piping works: node generate-brief.mjs ... > output.md

// CRITICAL: Guard all extracted fields with ?? [] before .map():
//   const ideas = extracted.ideas ?? [];
```

### Current Codebase Tree

```
podcast-brief/
├── scripts/
│   └── transcribe.mjs
└── package.json
```

### Desired Codebase Tree

```
podcast-brief/
├── scripts/
│   ├── transcribe.mjs
│   ├── generate-brief.mjs     ← NEW
│   └── sample-transcript.md   ← NEW
└── package.json               ← MODIFIED (dotenv devDependency)
```

---

## Implementation Blueprint

### Data Model (Claude JSON output)

```js
{
  speakerMap: { "Speaker 0": "Real Name", "Speaker 1": "Host" },
  ideas: [{ title: string, description: string }],        // up to 5
  quotes: [{ text: string, speaker: string }],            // up to 10
  references: [{ name: string, context: string }],        // all named entities
  questions: [string]                                     // up to 3
}
```

### Key Pseudocode

```js
// scripts/generate-brief.mjs
import { readFileSync, writeFileSync, existsSync } from "fs";
import { config } from "dotenv";

config({ path: new URL("../.env.local", import.meta.url).pathname });

// ── env + arg checks ──────────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing required env var: OPENAI_API_KEY");
  process.exit(1);
}
const [transcriptPath, episodeTitle = "Unknown Episode", episodeDescription = ""] = process.argv.slice(2);
if (!transcriptPath) { console.error("Usage: ..."); process.exit(1); }
if (!transcriptPath.endsWith(".md")) { console.error("Error: transcript must be a .md file"); process.exit(1); }
if (!existsSync(transcriptPath)) { console.error(`Error: file not found: ${transcriptPath}`); process.exit(1); }

// ── callOpenAI ────────────────────────────────────────────────────────────────
async function callOpenAI(system, user, { jsonMode = false, maxTokens = 3000 } = {}) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_tokens: maxTokens,
      temperature: 0.3,
      ...(jsonMode && { response_format: { type: "json_object" } }),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI error ${res.status}: ${err.error?.message ?? "unknown"}`);
  }
  return (await res.json()).choices[0].message.content;
}

// ── extraction ────────────────────────────────────────────────────────────────
const SYSTEM = `
You are an expert podcast analyst. The transcript uses generic speaker labels (Speaker 0, Speaker 1, etc.).
First infer each speaker's real name from conversational patterns, self-introductions, and episode metadata.

Return valid JSON:
{
  "speakerMap": { "Speaker 0": "Real Name", ... },
  "ideas": [{ "title": string, "description": string }],
  "quotes": [{ "text": string, "speaker": string }],
  "references": [{ "name": string, "context": string }],
  "questions": [string]
}

RULES:
- speakerMap: infer from context. Fallback: "Host" / "Guest".
- ideas: up to 5. Key insights a non-listener finds valuable. 2-3 sentence description each.
- quotes: up to 10. Verbatim. Use real name (not "Speaker N").
- references: ALL named entities with identity outside this conversation (books, papers, people,
    tools, concepts, orgs discussed with a specific angle). NOT passing mentions or generic nouns.
- questions: up to 3. Open-ended. Valuable without having heard the episode.
`;

const transcript = readFileSync(transcriptPath, "utf-8");
const userContent = `Episode title: ${episodeTitle}\nDescription: ${episodeDescription}\n\nTranscript:\n${transcript}`;

console.error("Extracting ideas, quotes, references, questions...");
const raw = await callOpenAI(SYSTEM, userContent, { jsonMode: true, maxTokens: 3000 });

let extracted;
try {
  extracted = JSON.parse(raw);
} catch {
  throw new Error(`Failed to parse Claude output as JSON:\n${raw}`);
}

const ideas = extracted.ideas ?? [];
const quotes = extracted.quotes ?? [];
const references = extracted.references ?? [];
const questions = extracted.questions ?? [];
console.error(`Speaker map: ${JSON.stringify(extracted.speakerMap)}`);
console.error(`${ideas.length} ideas, ${quotes.length} quotes, ${references.length} references, ${questions.length} questions`);

// ── assemble markdown ─────────────────────────────────────────────────────────
const brief = `# Podcast Brief

## Ideas
${ideas.map((idea, i) => `${i + 1}. **${idea.title}** — ${idea.description}`).join("\n")}

## Quotes
${quotes.map((q) => `> "${q.text}" — *${q.speaker}*`).join("\n\n")}

## References
${references.map((r) => `- **${r.name}** — ${r.context}`).join("\n")}

## Questions
${questions.map((q) => `- ${q}`).join("\n")}
`;

process.stdout.write("\n" + brief);
writeFileSync("brief-output.md", brief, "utf-8");
console.error("✓ Brief written to brief-output.md");
```

### Sample Transcript (`scripts/sample-transcript.md`)

Must use `Speaker N` labels and include:
- A self-introduction or name-drop for speaker inference
- At least one quotable line
- One named reference (book, concept, paper, person)
- ~15 turns of real substance

```
**[00:00:04] Speaker 0:** Welcome back. I'm joined today by Arthur Brooks...
**[00:00:10] Speaker 1:** Great to be here...
**[00:00:33] Speaker 0:** Your book "From Strength to Strength" argues that...
```

### Tasks

```yaml
Task 1 — Install dotenv:
  RUN: npm install --save-dev dotenv
  VERIFY: package.json devDependencies includes dotenv

Task 2 — Create scripts/sample-transcript.md:
  ~15–20 turns, Speaker 0 / Speaker 1 labels
  Include: name-drop, quotable line, named reference, substantive discussion

Task 3 — Create scripts/generate-brief.mjs:
  Implement exactly as pseudocode above.
  All imports at top. config() called before env check.

Task 4 — Update .env.local (if OPENAI_API_KEY not already present):
  Confirm OPENAI_API_KEY line exists (it should already be there)
```

---

## Validation Loop

```bash
# 1. Missing arg guard
node scripts/generate-brief.mjs
# Expected: usage message, exit 1

# 2. Wrong extension guard
node scripts/generate-brief.mjs scripts/sample-transcript.json "Title"
# Expected: "Error: transcript must be a .md file"

# 3. Missing env var (temporarily unset)
OPENAI_API_KEY="" node scripts/generate-brief.mjs scripts/sample-transcript.md "Title"
# Expected: "Missing required env var: OPENAI_API_KEY"

# 4. End-to-end run
node scripts/generate-brief.mjs scripts/sample-transcript.md "Sample Episode" "A conversation about resilience."
# Expected: step logs to stderr, brief to stdout, brief-output.md written

# 5. Inspect output
cat brief-output.md
# Expected: all 4 sections, speaker names (not "Speaker 0"), no "[object Object]" or "undefined"
```

## Anti-Patterns to Avoid

- Do NOT import `libs/gpt.js` — wrong model, no JSON mode, Next.js module
- Do NOT use `import "dotenv/config"` — reads `.env` not `.env.local`
- Do NOT use `require()` — this is `.mjs`, ESM only
- Do NOT install `dotenv` as a regular dependency — devDependency only
- Do NOT use `console.log()` in main block — pollutes stdout piping
- Do NOT accept `.json` or `.txt` — exit cleanly on wrong extension
