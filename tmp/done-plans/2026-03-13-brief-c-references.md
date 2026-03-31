# Plan C: Reference Enrichment with Exa

## Goal

Two new standalone scripts that enrich the REFERENCES section from extract_wisdom output and splice them back into the generated brief. **`generate-brief.mjs` is not touched.**

**Branch:** `brief-c-references`
**Prerequisite:** Plan B implemented and working (produces `briefs/{podcastID}-final-brief.md`).

## What

```bash
# Step 1 — parse, filter, normalize, and look up URLs for all references
node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# → writes briefs/abc123-references.md

# Step 2 — splice enriched references into the generated brief
node scripts/merge-references.mjs briefs/abc123-output.md briefs/abc123-references.md
# → writes briefs/abc123-final-brief.md
```

`enrich-references.mjs` reads the raw extract_wisdom markdown, enriches the REFERENCES section, and writes a standalone references file. `merge-references.mjs` replaces the `# REFERENCES` section in the extract_wisdom markdown with the enriched version and writes the final brief.

### Success Criteria

- [ ] `enrich-references.mjs` parses `# REFERENCES` from extract_wisdom markdown
- [ ] Generic references are filtered out; specific ones get typos fixed and a targeted query
- [ ] Each kept reference gets an Exa URL (or is shown name-only if none found)
- [ ] Exa failures produce a descriptive error message, not silent null
- [ ] `briefs/{podcastID}-references.md` is written with enriched references
- [ ] `merge-references.mjs` replaces the `# REFERENCES` section in the brief with enriched content
- [ ] `briefs/{podcastID}-final-brief.md` is written by merge script
- [ ] Script exits clearly if `EXA_API_KEY` or `OPENROUTER_API_KEY` is missing
- [ ] `generate-brief.mjs` is not modified

---

## All Needed Context

### How extract_wisdom Formats REFERENCES

```
# REFERENCES

- Josef Pieper's book "Leisure, The Basis of Culture"
- Ralph Waldo Emerson's essay "Self Reliance"
- Richard Wiseman's psychology research on luck
- The Matrix (1999 film)
```

Plain bullet list — names/titles only, no URLs. Parse by:
1. Find the line matching `/^#{1,3}\s*REFERENCES/i`
2. Collect lines starting with `- ` or `* ` until the next `#` heading or EOF
3. Strip the leading `- ` to get the reference name

### New Environment Variables

```bash
EXA_API_KEY         # from exa.ai dashboard
OPENROUTER_API_KEY  # from openrouter.ai dashboard
```

Add placeholders to `.env.example`.

### Exa SDK

Use the official `exa-js` SDK — **not** raw `fetch()`:

```js
import Exa from "exa-js";
const exa = new Exa(process.env.EXA_API_KEY);
const response = await exa.search(query, { numResults: 1 });
// response.results[0]?.url
```

Install: `npm install --save-dev exa-js`

### References Column (Supabase)

Migration `20260314000000_add_references_to_briefs.sql` already adds `references jsonb` to `briefs`.
The merge script (or a later worker) can write `[{ name, url }]` there — out of scope for this plan.

### Files Being Changed

```
podcast-brief/
├── scripts/
│   ├── enrich-references.mjs   ← NEW
│   └── merge-references.mjs    ← NEW
└── .env.example                ← MODIFIED (add EXA_API_KEY= placeholder)
```

`generate-brief.mjs` is NOT touched.

### Known Gotchas

```js
// CRITICAL: generate-brief.mjs is NOT modified. These are standalone scripts.

// CRITICAL: parseReferences() — match header with /^#{1,3}\s*REFERENCES/i
// Output may use "# REFERENCES" or "## REFERENCES" depending on model run.

// CRITICAL: filterAndNormalize() returns { name, query }[] — not string[].
// name = display label (typos fixed). query = targeted Exa search string.
// Do NOT use raw reference names as Exa queries.

// CRITICAL: exaSearch() returns { url: string | null, error: string | null }.
// Never silently return null on failure — surface a descriptive error message.

// CRITICAL: batchedAll() — batch Exa searches in groups of 5 to avoid rate limits.

// CRITICAL: EXA_API_KEY and OPENROUTER_API_KEY must be checked at startup, not at point of use.

// CRITICAL: merge-references.mjs replaces the entire # REFERENCES section
// (from the header line to the next # heading or EOF) with the enriched content.
// Do not touch any other section of the brief.
// If no REFERENCES section is found, exit(1) — this input is not valid extract_wisdom output.
```

---

## Implementation Blueprint

### Script 1: `scripts/enrich-references.mjs`

```js
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import Exa from "exa-js";

// ── env check ─────────────────────────────────────────────────────────────────
for (const key of ["OPENROUTER_API_KEY", "EXA_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const exa = new Exa(process.env.EXA_API_KEY);

// ── parse references from extract_wisdom markdown ─────────────────────────────
function parseReferences(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{1,3}\s*REFERENCES/i.test(l));
  if (start === -1) return [];
  const refs = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) break;
    const match = lines[i].match(/^[-*]\s+(.+)/);
    if (match) refs.push(match[1].trim());
  }
  return refs;
}

// ── AI filter + normalize ─────────────────────────────────────────────────────
// One call: filters out generic entries AND produces { name, query } for each kept ref.
async function filterAndNormalize(names) {
  if (names.length === 0) return [];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-flash-2.0",
      response_format: { type: "json_object" },
      max_tokens: 800,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are cleaning up a list of podcast references for web lookup.
For each reference, decide:
1. Should it have a URL? Keep if: book, paper, study, talk, tool, named concept, or specific work discussed in depth.
   Skip if: generic famous person or company mentioned only in passing.
2. If keeping: fix any typos and make the name more specific, then write a targeted search query.
   Examples:
   - "Cantral ladder happiness measurement scale" → name: "Cantril Ladder", query: "Cantril Ladder happiness scale psychology"
   - "The French luck philosopher's four quadrants" → query: "Richard Wiseman luck four quadrants book"
   - "Josef Pieper's book Leisure, The Basis of Culture" → query: "Josef Pieper Leisure The Basis of Culture book"
   If unsure of missing details, keep the query close to the original — do NOT invent facts.
Return JSON only: { "refs": [{ "name": "display name", "query": "exa search query" }] }`,
        },
        { role: "user", content: JSON.stringify(names) },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenRouter error ${res.status}: ${err.error?.message ?? "unknown"}`);
  }
  const data = await res.json();
  try {
    const { refs } = JSON.parse(data.choices[0].message.content);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return names.map((n) => ({ name: n, query: n })); // fallback: keep all with identity query
  }
}

// ── Exa search ────────────────────────────────────────────────────────────────
// Returns { url, error } — never silently null on failure.
async function exaSearch(query) {
  try {
    const response = await exa.search(query, { numResults: 1 });
    const url = response.results[0]?.url ?? null;
    return { url, error: url ? null : "No results found" };
  } catch (e) {
    return { url: null, error: e.message ?? "Unknown Exa error" };
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

// ── main ──────────────────────────────────────────────────────────────────────
const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/enrich-references.mjs <extract-wisdom-output.md>");
  process.exit(1);
}

const markdown = readFileSync(inputPath, "utf-8");
const names = parseReferences(markdown);
if (names.length === 0) {
  console.error("No REFERENCES section found in input.");
  process.exit(0);
}

console.error(`Found ${names.length} references. Filtering and normalizing via AI...`);
const filtered = await filterAndNormalize(names);
console.error(`→ ${filtered.length}/${names.length} kept`);

if (filtered.length === 0) {
  console.error("All references filtered out — nothing to write.");
  process.exit(0);
}

console.error("Looking up URLs via Exa...");
const resolved = await batchedAll(filtered, async ({ name, query }) => {
  const { url, error } = await exaSearch(query);
  if (error && !url) console.error(`  ⚠ "${name}": ${error}`);
  return { name, url };
});
const found = resolved.filter((r) => r.url).length;
console.error(`→ ${found}/${resolved.length} URLs found`);

const lines = resolved.map((r) =>
  r.url ? `- [${r.name}](${r.url})` : `- ${r.name}`
);
const referencesMarkdown = `# Enriched References\n\n${lines.join("\n")}\n`;

// Strip "-output" suffix so "abc123-output.md" → "abc123-references.md" not "abc123-output-references.md"
const stem = path.basename(inputPath, path.extname(inputPath));
const podcastID = stem.replace(/-output$/, "");
const brifsDir = path.join(process.cwd(), "briefs");
mkdirSync(brifsDir, { recursive: true });
const outPath = path.join(brifsDir, `${podcastID}-references.md`);
writeFileSync(outPath, referencesMarkdown, "utf-8");
console.error(`✓ Written to ${outPath}`);
```

---

### Script 2: `scripts/merge-references.mjs`

Replaces the `# REFERENCES` section in the extract_wisdom markdown with the enriched references and writes the final brief.

```js
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

const [briefPath, referencesPath] = process.argv.slice(2);
if (!briefPath || !referencesPath) {
  console.error(
    "Usage: node scripts/merge-references.mjs <extract-wisdom-output.md> <podcastID-references.md>"
  );
  process.exit(1);
}

const brief = readFileSync(briefPath, "utf-8");
const enrichedRefs = readFileSync(referencesPath, "utf-8");

// Find and replace the # REFERENCES section
const lines = brief.split("\n");
const sectionStart = lines.findIndex((l) => /^#{1,3}\s*REFERENCES/i.test(l));
if (sectionStart === -1) {
  console.error("Error: No REFERENCES section found in brief. Was this generated by extract_wisdom?");
  process.exit(1);
}

// Find where the section ends (next heading or EOF)
let sectionEnd = lines.length;
for (let i = sectionStart + 1; i < lines.length; i++) {
  if (/^#{1,3}\s/.test(lines[i])) {
    sectionEnd = i;
    break;
  }
}

// trimEnd/trimStart prevents stacked blank lines when sections already have trailing/leading whitespace
const before = lines.slice(0, sectionStart).join("\n").trimEnd();
const after = lines.slice(sectionEnd).join("\n").trimStart();
const finalBrief = [before, enrichedRefs.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";

writeFinal(briefPath, finalBrief);

function writeFinal(inputPath, content) {
  const stem = path.basename(inputPath, path.extname(inputPath));
  const podcastID = stem.replace(/-output$/, "");
  const brifsDir = path.join(process.cwd(), "briefs");
  mkdirSync(brifsDir, { recursive: true });
  const outPath = path.join(brifsDir, `${podcastID}-final-brief.md`);
  writeFileSync(outPath, content, "utf-8");
  console.error(`✓ Written to ${outPath}`);
}
```

---

### Tasks

```yaml
Task 1 — Install exa-js and update .env.example:
  RUN: npm install --save-dev exa-js
  Add EXA_API_KEY= and OPENROUTER_API_KEY= lines to .env.example

Task 2 — Create scripts/enrich-references.mjs:
  Implement exactly as pseudocode above.
  Functions: parseReferences, filterAndNormalize, exaSearch, batchedAll.
  exaSearch uses exa-js SDK (not fetch). Returns { url, error } — never silent null.
  Output: briefs/{podcastID}-references.md

Task 3 — Create scripts/merge-references.mjs:
  Implement exactly as pseudocode above.
  Finds and replaces the # REFERENCES section in the brief.
  Falls back to appending if no section found.
  Output: briefs/{podcastID}-final-brief.md

NOTE: Do NOT modify generate-brief.mjs.
```

---

## Validation Loop

```bash
# 1. Missing env vars
EXA_API_KEY="" node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# Expected: "Missing required env var: EXA_API_KEY", exit 1
OPENROUTER_API_KEY="" node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# Expected: "Missing required env var: OPENROUTER_API_KEY", exit 1

# 2. Run enrich-references end-to-end
node --env-file=.env.local scripts/enrich-references.mjs briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-output.md
# Expected:
#   - "Found N references. Filtering and normalizing via AI..." logged
#   - "→ N/M kept" logged
#   - "→ N/M URLs found" logged
#   - Any Exa failures show descriptive warning, not silent skip
#   - briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-references.md written

# 3. Inspect references output
cat briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-references.md
# Expected:
#   - "# Enriched References" heading
#   - Entries with URLs as [Name](url)
#   - Entries without URLs as plain "- Name"
#   - No "null" or broken markdown

# 4. Run merge-references
node scripts/merge-references.mjs \
  briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-output.md \
  briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-references.md
# Expected:
#   - briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-final-brief.md written

# 5. Verify merge result
grep -n "REFERENCES\|Enriched" briefs/10181087-f8c6-5fc9-b074-7c5e33da503d-final-brief.md
# Expected: original "# REFERENCES" replaced by "# Enriched References"
# All other sections untouched
```

---

# Brief: validate-references script with Browserbase

## Why
Exa's top result is neural — it finds what it thinks is the best match, but URLs can be dead, 404, or wrong. We need a validation step to confirm links actually load before they appear in the final brief.

## Context
- `enrich-references.mjs` currently calls `exaSearch()` with `numResults: 1`, no type/autoprompt params, and outputs `{id}-references.md` (markdown with one URL per reference)
- `merge-references.mjs` reads that markdown and splices it into the final brief — unchanged
- The intermediate markdown format needs to change to JSON to carry multiple candidate URLs
- Browserbase is the right tool here (not plain fetch) because many book/academic/publisher pages require JS rendering or block bots

## Decisions
- **Upgrade enrich's Exa call upfront** — use `numResults: 3`, `type: "auto"`, `use_autoprompt: true`, `livecrawl: "fallback"` from the start. Better params on the first call, not just on retry. Reasoning: same cost as numResults:1, gives 3 candidates, eliminates the need for any second Exa call.
- **Change intermediate format to JSON** — enrich writes `{id}-references.json` with shape `[{ name: string, candidates: string[] }]`. Validate reads this, picks the first passing URL, writes final `{id}-references.md` for merge.
- **Validate tries candidates in order** — Browserbase loads each URL; first one that returns a valid page wins. If all 3 fail, keep the reference text but omit the link.
- **No second Exa call ever** — the 3 candidates from the first search are the only retry budget. Simpler, cheaper.
- **merge-references.mjs is untouched** — it still reads `{id}-references.md` markdown as before.

## Rejected Alternatives
- **Retry with a second Exa call on failure** — wasteful; costs 2 Exa calls per bad reference when 3 candidates upfront achieves the same goal for 1 call.
- **Plain fetch() HEAD request for validation** — many publisher/academic pages block bots or require JS; Browserbase handles this reliably.
- **Embed candidates as HTML comments in markdown** — hacky, not worth the complexity.

## Direction
Modify `enrich-references.mjs` to fetch 3 candidate URLs per reference using upgraded Exa params and write a JSON intermediate file. Add a new `validate-references.mjs` script that uses Browserbase to try each candidate in order, writing the final markdown that merge already expects. The pipeline becomes: enrich (→ JSON) → validate (→ markdown) → merge (unchanged).

---

## Anti-Patterns to Avoid

- Do NOT modify `generate-brief.mjs` — these are standalone scripts
- Do NOT use raw `fetch()` for Exa — use the `exa-js` SDK (`import Exa from "exa-js"`)
- Do NOT return `null` silently from `exaSearch` — return `{ url: null, error: "descriptive message" }`
- Do NOT use raw reference names as Exa queries — use the AI-generated `query` from `filterAndNormalize`
- Do NOT run all Exa searches at once — use `batchedAll(batchSize=5)`
- Do NOT check API keys lazily — check both `OPENAI_API_KEY` and `EXA_API_KEY` at startup
- Do NOT hardcode `# REFERENCES` — match with `/^#{1,3}\s*REFERENCES/i`
- Do NOT invent facts in the AI normalization prompt — keep vague entries vague
- Do NOT append to the brief if REFERENCES is missing — exit(1) with a clear error message
