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
      model: "google/gemini-2.5-flash",
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
// Returns { candidates, error } — never silently null on failure.
async function exaSearch(query) {
  try {
    // 3 candidates per reference gives validate-references.mjs fallback options without a second Exa call
    const response = await exa.search(query, {
      numResults: 3,
      type: "auto", // explicit default — Exa changed auto to default in 2024, being explicit for clarity
      excludeDomains: [
        "linkedin.com",  // prefer official bios, publisher pages, or editorial articles
        "google.com",    // avoid Google redirect/search URLs
      ],
    });
    const candidates = response.results.map((r) => r.url); // url is always a string per Exa OpenAPI spec
    return { candidates, error: candidates.length ? null : "No results found" };
  } catch (e) {
    return { candidates: [], error: e.message ?? "Unknown Exa error" };
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
let filtered = await filterAndNormalize(names);
console.error(`→ ${filtered.length}/${names.length} kept`);

if (filtered.length > 50) {
  console.error(`WARNING: ${filtered.length} references found, capping at 50`);
  filtered = filtered.slice(0, 50);
}

if (filtered.length === 0) {
  console.error("All references filtered out — nothing to write.");
  process.exit(0);
}

console.error("Fetching candidates via Exa...");
const resolved = await batchedAll(filtered, async ({ name, query }) => {
  const { candidates, error } = await exaSearch(query);
  if (error && !candidates.length) console.error(`  ⚠ "${name}": ${error}`);
  return { name, candidates };
});
const found = resolved.filter((r) => r.candidates.length > 0).length;
console.error(`→ ${found}/${resolved.length} with candidates`);

// Strip "-output" suffix so "abc123-output.md" → "abc123-references.json" not "abc123-output-references.json"
const stem = path.basename(inputPath, path.extname(inputPath));
const podcastID = stem.replace(/-output$/, "");
const brifsDir = path.join(process.cwd(), "briefs");
mkdirSync(brifsDir, { recursive: true });
const outPath = path.join(brifsDir, `${podcastID}-references.json`);
writeFileSync(outPath, JSON.stringify(resolved, null, 2), "utf-8");
console.error(`✓ Written to ${outPath}`);
