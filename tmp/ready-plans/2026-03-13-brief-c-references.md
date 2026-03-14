# Plan C: Reference Enrichment with Exa

## Goal

Extend `scripts/generate-brief.mjs` (from Plan B) to parse the REFERENCES section from the extract_wisdom markdown output, filter out generic entries, look up a URL for each via Exa, and **append an enriched References section** to the end of the brief.

**Branch:** `brief-c-references`
**Prerequisite:** Plan B implemented and working.

## What

Same CLI — no interface change. After the brief is generated, the script:
1. Parses reference names from the `# REFERENCES` section of the markdown
2. One Claude call to filter out generic/uninteresting ones
3. One Exa search per filtered reference → top URL
4. Appends `## Enriched References` block to the end of the brief

```bash
node --env-file=.env.local scripts/generate-brief.mjs transcripts/foo.md "Title" "Description"
# → same markdown as before, but with enriched references appended at the end
```

### Success Criteria

- [ ] REFERENCES section is correctly parsed from extract_wisdom markdown output
- [ ] Generic references (passing mentions of famous companies/people) are filtered out
- [ ] Specific references (books, papers, talks, tools) get an Exa URL
- [ ] Enriched references appended to the end of `brief-output.md` and stdout
- [ ] References with no Exa result appear with name only (no broken link)
- [ ] Script exits clearly if `EXA_API_KEY` is missing
- [ ] All existing Plan B success criteria still pass

---

## All Needed Context

### How extract_wisdom Formats REFERENCES

The REFERENCES section in extract_wisdom output looks like:
```
# REFERENCES

- The Happiness Advantage by Shawn Achor
- Arthur Brooks' research on happiness and success
- Harvard Study of Adult Development
- Flow by Mihaly Csikszentmihalyi
```

Plain bullet list — just names/titles, no context. Parse by:
1. Find the line containing `REFERENCES`
2. Collect lines starting with `- ` until the next `#` heading or end of file
3. Strip the leading `- ` to get the reference name

### New Environment Variable

```bash
EXA_API_KEY   # from exa.ai dashboard
```

Add placeholder to `.env.example` and `.env.local`.

### Exa REST API

No SDK — plain `fetch()`:

```js
POST https://api.exa.ai/search
Headers: { "x-api-key": process.env.EXA_API_KEY, "Content-Type": "application/json" }
Body: { query: string, numResults: 1, type: "auto" }
Response: { results: [{ url: string, title: string }] }
```

### Files Being Changed

```
podcast-brief/
├── scripts/
│   └── generate-brief.mjs   ← MODIFIED (add parseReferences, filterReferences, exaSearch, enrichReferences)
└── .env.example             ← MODIFIED (add EXA_API_KEY= placeholder)
```

### Known Gotchas

```js
// CRITICAL: EXA_API_KEY check must happen at startup alongside OPENAI_API_KEY —
// not at the point of use. Fail fast before making any API calls.

// CRITICAL: parseReferences() — the section header may be "# REFERENCES" or
// "## REFERENCES" depending on model output. Match with a regex: /^#{1,3}\s*REFERENCES/i

// CRITICAL: batchedAll() with batchSize=5 — don't run all Exa searches in one
// Promise.all() or you'll hit rate limits.

// CRITICAL: References with no Exa result must still appear in output.
// Don't drop them — show name only.

// CRITICAL: The enriched section is APPENDED to the existing brief string.
// Do not replace or reformat the rest of the brief.

// CRITICAL: Write the final brief (original + appended section) to both
// process.stdout.write() and writeFileSync("brief-output.md") — same content.
```

---

## Implementation Blueprint

### Key Pseudocode

Add these functions to `scripts/generate-brief.mjs` after the existing `callOpenAI` function:

```js
// ── parse references from extract_wisdom markdown output ──────────────────────
function parseReferences(markdown) {
  const lines = markdown.split("\n");
  const sectionStart = lines.findIndex((l) => /^#{1,3}\s*REFERENCES/i.test(l));
  if (sectionStart === -1) return [];
  const refs = [];
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i])) break; // next section
    const match = lines[i].match(/^[-*]\s+(.+)/);
    if (match) refs.push(match[1].trim());
  }
  return refs;
}

// ── filter to linkable references ─────────────────────────────────────────────
async function filterReferences(names) {
  if (names.length === 0) return [];
  const raw = await callOpenAI(
    `You are filtering a list of podcast references.
Keep a reference if a curious listener would benefit from a specific URL
(books, papers, studies, talks, tools, specific concepts with a dedicated page).
Skip if: generic famous person or company mentioned in passing with no specific angle.
Return JSON only: { "keep": ["name1", "name2", ...] }`,
    JSON.stringify(names),
    { jsonMode: true, maxTokens: 500 }
  );
  try {
    const { keep } = JSON.parse(raw);
    const keepSet = new Set(keep);
    return names.filter((n) => keepSet.has(n));
  } catch {
    return names; // on parse failure, keep all
  }
}

// ── Exa URL lookup ────────────────────────────────────────────────────────────
async function exaSearch(query) {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": process.env.EXA_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, numResults: 1, type: "auto" }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const result = data.results?.[0];
  return result?.url ?? null;
}

async function batchedAll(items, fn, batchSize = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    results.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)));
  }
  return results;
}

async function enrichReferences(markdown) {
  const names = parseReferences(markdown);
  if (names.length === 0) return "";

  console.error(`  Filtering ${names.length} references...`);
  const filtered = await filterReferences(names);
  console.error(`  → ${filtered.length}/${names.length} kept`);

  console.error(`  Looking up URLs via Exa...`);
  const resolved = await batchedAll(filtered, async (name) => {
    try {
      const url = await exaSearch(name);
      return { name, url };
    } catch (e) {
      console.error(`  Warning: Exa failed for "${name}": ${e.message}`);
      return { name, url: null };
    }
  });
  const found = resolved.filter((r) => r.url).length;
  console.error(`  → ${found}/${resolved.length} URLs found`);

  const lines = resolved.map((r) =>
    r.url ? `- [${r.name}](${r.url})` : `- ${r.name}`
  );
  return `\n\n## Enriched References\n\n${lines.join("\n")}`;
}
```

Update the env check at the top of the script:
```js
for (const key of ["OPENAI_API_KEY", "EXA_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
```

Update the main try block — after `mergeChunks` returns `brief`, add:
```js
  console.error("Enriching references...");
  const enriched = await enrichReferences(brief);
  const finalBrief = brief + enriched;

  process.stdout.write(finalBrief);
  writeFileSync("brief-output.md", finalBrief, "utf-8");
  console.error("✓ Brief written to brief-output.md");
```

### Tasks

```yaml
Task 1 — Add EXA_API_KEY to env check and .env.example:
  Update startup env check to loop over ["OPENAI_API_KEY", "EXA_API_KEY"]
  Add EXA_API_KEY= line to .env.example

Task 2 — Add parseReferences(), filterReferences(), exaSearch(), batchedAll(), enrichReferences():
  Add all functions after callOpenAI() in generate-brief.mjs

Task 3 — Update main try block:
  After mergeChunks(), call enrichReferences(brief)
  Concatenate result to brief before writing to stdout and file
```

---

## Validation Loop

```bash
# 1. Missing EXA_API_KEY
EXA_API_KEY="" node --env-file=.env.local scripts/generate-brief.mjs transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Title"
# Expected: "Missing required env var: EXA_API_KEY", exit 1

# 2. End-to-end run
node --env-file=.env.local scripts/generate-brief.mjs transcripts/arthur-c-brooks-are-we-happy-yet-2026-03-12.md "Are We Happy Yet?" "Arthur C. Brooks on happiness research."
# Expected:
#   - "Filtering N references..." logged
#   - "N/M kept" logged
#   - "N/M URLs found" logged
#   - brief-output.md ends with "## Enriched References" section

# 3. Inspect output
tail -30 brief-output.md
# Expected:
#   - "## Enriched References" section present
#   - At least some entries have [Name](url) format
#   - No broken links or "null" in output
#   - Entries with no URL show just "- Name" (no broken markdown)
```

## Anti-Patterns to Avoid

- Do NOT use the `exa-js` SDK class — use `fetch()` directly
- Do NOT replace the existing REFERENCES section — append a new "## Enriched References" section at the end
- Do NOT drop references that get no Exa result — show them without a URL
- Do NOT run all Exa searches at once — use `batchedAll(batchSize=5)`
- Do NOT check EXA_API_KEY lazily (at point of use) — check it at startup with OPENAI_API_KEY
- Do NOT hardcode reference parsing to expect exactly `# REFERENCES` — match with `/^#{1,3}\s*REFERENCES/i`
