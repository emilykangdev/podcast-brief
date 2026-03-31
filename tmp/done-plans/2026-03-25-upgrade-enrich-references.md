# Plan: Upgrade enrich-references.mjs to 3 candidates + JSON output

## Goal

Modify `scripts/enrich-references.mjs` to:
1. Fetch 3 candidate URLs per reference (instead of 1) using upgraded Exa params
2. Write a JSON intermediate file `briefs/{podcastID}-references.json` instead of markdown

`merge-references.mjs` and `validate-references.mjs` are **not touched** by this plan.

⚠️ **This plan must be implemented together with `2026-03-25-validate-references-browserbase.md`.**
After this plan runs, `enrich-references.mjs` no longer writes a `.md` file, so
`merge-references.mjs` cannot be run until `validate-references.mjs` exists to bridge JSON → markdown.

## Why

- `numResults: 1` gives no fallback — if Exa's top result is a dead URL, there's nothing to try
- 3 candidates gives `validate-references.mjs` options to work with without a second Exa call
- JSON is a cleaner intermediate format for a multi-candidate structure than markdown

## What

**Before:**
```bash
node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# → writes briefs/abc123-references.md  (markdown, 1 URL per ref)
```

**After:**
```bash
node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# → writes briefs/abc123-references.json  (JSON, up to 3 URLs per ref)
```

**Output path is auto-derived from the input path** — you never specify it manually:
```
briefs/
  abc123-output.md          ← input (you pass this)
  abc123-references.json    ← output (auto-generated next to it)
```
The script strips `-output` from the input filename, changes the extension to `.json`,
and writes the result in the same directory as the input file.

**Output JSON shape:**
```json
[
  { "name": "Cantril Ladder", "candidates": ["https://...", "https://...", "https://..."] },
  { "name": "Thinking, Fast and Slow", "candidates": ["https://..."] },
  { "name": "No URL Found Ref", "candidates": [] }
]
```

### Success Criteria

- [ ] `exaSearch()` uses `numResults: 3` and `type: "auto"`
- [ ] `exaSearch()` returns `{ candidates: string[], error }` instead of `{ url, error }`
- [ ] `batchedAll` result shape is `[{ name, candidates }]` not `[{ name, url }]`
- [ ] Log line updated to `"Fetching candidates via Exa..."`
- [ ] Output written to `briefs/{podcastID}-references.json`
- [ ] JSON shape is `[{ name: string, candidates: string[] }]`
- [ ] Markdown output code fully removed
- [ ] All other logic unchanged: env check, parseReferences, filterAndNormalize, batchedAll
- [ ] After filterAndNormalize: if filtered.length > 50, slice to 50 and log WARNING (safety cap — generate-brief.mjs is the primary limit at 50, this is a defensive backstop)

## All Needed Context

### Documentation & References

```yaml
- file: scripts/enrich-references.mjs
  why: Only exaSearch() and the output block change. Everything else stays identical.
       Read the full file before editing — variable declarations like outPath, brifsDir,
       podcastID already exist and must be modified in place, not re-declared.
```

### Files Being Changed

```
scripts/
  enrich-references.mjs   ← MODIFIED
```

### Known Gotchas

```js
// exaSearch() currently returns { url: string | null, error }
// It must return { candidates: string[], error } after this change.
// An empty candidates array [] means no results — never null.

// The batchedAll callback currently returns { name, url }.
// It must return { name, candidates } after this change.

// No .filter(Boolean) on candidates — Exa's OpenAPI spec types url as string (not
// nullable) on every result object, so filtering is dead code. If Exa ever returns
// something unexpected here, we want to know about it, not silently drop it.

// numResults: 3 is intentional — gives validate-references.mjs fallback candidates
// without a second Exa call. Add an inline comment in the code: "3 candidates per
// reference gives validate-references.mjs fallback options without a second Exa call"

// The output block currently builds markdown lines and assigns outPath on line 139.
// MODIFY the existing outPath declaration in place (change .md → .json extension only)
// and replace the writeFileSync content argument — do NOT add a new const outPath
// declaration alongside the existing one. Also delete the lines and referencesMarkdown
// variable declarations entirely (lines 129-132 in the current file).

// merge-references.mjs reads -references.md and will break after this plan runs.
// The full pipeline is not runnable end-to-end until validate-references.mjs is
// also implemented (2026-03-25-validate-references-browserbase.md).
// Implement both plans before testing the full pipeline.
```

## Implementation Blueprint

### Diff — exaSearch()

```js
// BEFORE:
async function exaSearch(query) {
  try {
    const response = await exa.search(query, { numResults: 1 });
    const url = response.results[0]?.url ?? null;
    return { url, error: url ? null : "No results found" };
  } catch (e) {
    return { url: null, error: e.message ?? "Unknown Exa error" };
  }
}

// AFTER:
async function exaSearch(query) {
  try {
    // 3 candidates per reference gives validate-references.mjs fallback options without a second Exa call
    const response = await exa.search(query, {
      numResults: 3,
      type: "auto", // explicit default — Exa changed auto to default in 2024, being explicit for clarity
    });
    const candidates = response.results.map((r) => r.url); // url is always a string per Exa OpenAPI spec
    return { candidates, error: candidates.length ? null : "No results found" };
  } catch (e) {
    return { candidates: [], error: e.message ?? "Unknown Exa error" };
  }
}
```

### Diff — log line + batchedAll call + output block

```js
// BEFORE:
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

// AFTER (modify in place — do not re-declare stem/podcastID/brifsDir/outPath):
console.error("Fetching candidates via Exa...");
const resolved = await batchedAll(filtered, async ({ name, query }) => {
  const { candidates, error } = await exaSearch(query);
  if (error && !candidates.length) console.error(`  ⚠ "${name}": ${error}`);
  return { name, candidates };
});
const found = resolved.filter((r) => r.candidates.length > 0).length;
console.error(`→ ${found}/${resolved.length} with candidates`);

// stem/podcastID/brifsDir/mkdirSync lines stay exactly as-is
// DELETE the lines and referencesMarkdown variable declarations entirely
// MODIFY the existing outPath line in place (.md → .json) and writeFileSync content:
//   outPath: `${podcastID}-references.json`   (was -references.md)
//   writeFileSync: JSON.stringify(resolved, null, 2)  (was referencesMarkdown)
```

### Tasks

```yaml
Task 1:
MODIFY scripts/enrich-references.mjs — 5 targeted edits, nothing else:
  1. Replace exaSearch() body — new params (numResults:3, type:"auto"),
     return { candidates, error } instead of { url, error }
  2. Update log line: "Looking up URLs via Exa..." → "Fetching candidates via Exa..."
  3. Update batchedAll callback — destructure candidates, return { name, candidates }
  4. Update found count: r.url → r.candidates.length > 0; log "with candidates"
  5. In the output block:
     - DELETE the lines variable declaration and the referencesMarkdown variable declaration
     - MODIFY the existing outPath line in place: change -references.md → -references.json
     - MODIFY the existing writeFileSync call: replace referencesMarkdown with JSON.stringify(resolved, null, 2)
     - Do NOT re-declare stem, podcastID, brifsDir, mkdirSync, or outPath
```

## Validation Loop

```bash
node --env-file=.env.local scripts/enrich-references.mjs briefs/<some>-output.md
# Expected: briefs/<podcastID>-references.json written

cat briefs/<podcastID>-references.json
# Expected: JSON array, each entry { name: "...", candidates: ["url", "url", "url"] }
# Entries with no Exa results: { name: "...", candidates: [] }

npm run lint
```

## Final Validation Checklist

- [ ] `npm run lint` passes
- [ ] `exaSearch()` uses `numResults: 3` and `type: "auto"` only (no livecrawl, no use_autoprompt)
- [ ] `exaSearch()` returns `{ candidates: string[], error }` — no `url` field anywhere
- [ ] Log line reads `"Fetching candidates via Exa..."`
- [ ] No `url` references remain in the modified sections
- [ ] No duplicate variable declarations (stem, podcastID, brifsDir, outPath)
- [ ] Output file is `briefs/{podcastID}-references.json`
- [ ] JSON shape: `[{ name: string, candidates: string[] }]`
- [ ] Markdown output code fully removed (lines variable, referencesMarkdown variable)
