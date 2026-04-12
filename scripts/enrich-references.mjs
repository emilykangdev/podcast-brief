import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Exa from "exa-js";
import { extractSection } from "./markdown.mjs";

// ── parse references from extract_wisdom markdown ─────────────────────────────
function parseReferences(markdown) {
  const section = extractSection(markdown, "REFERENCES");
  if (!section) return [];
  return section.content
    .split("\n")
    .map((line) => line.match(/^[-*]\s+(.+)/))
    .filter(Boolean)
    .map((match) => match[1].trim());
}

// ── AI normalize ─────────────────────────────────────────────────────────────
// Keeps ALL references — fixes typos, makes names specific, and generates search queries.
async function filterAndNormalize(names, { posthog = null, profileId = null, traceId = null, pipelineSpanId = null } = {}) {
  if (names.length === 0) return [];
  const enrichMessages = [
    {
      role: "system",
      content: `You are cleaning up a list of podcast references for web lookup.
Keep ALL references — every person, organization, court case, book, paper, study, tool, concept, or company. Do NOT filter anything out. The user wants a complete list so they can look up anyone or anything mentioned.
For each reference: fix any typos, make the name more specific, then write a targeted search query.
   Examples:
   - "Cantral ladder happiness measurement scale" → name: "Cantril Ladder", query: "Cantril Ladder happiness scale psychology"
   - "The French luck philosopher's four quadrants" → name: "Richard Wiseman", query: "Richard Wiseman luck four quadrants book"
   - "Josef Pieper's book Leisure, The Basis of Culture" → name: "Leisure, The Basis of Culture by Josef Pieper", query: "Josef Pieper Leisure The Basis of Culture book"
   - "Erin Murphy" → name: "Erin Murphy", query: "Erin Murphy law professor DNA privacy"
   If unsure of missing details, keep the query close to the original — do NOT invent facts.
Return JSON only: { "refs": [{ "name": "display name", "query": "exa search query" }] }`,
    },
    { role: "user", content: JSON.stringify(names) },
  ];
  const start = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      response_format: { type: "json_object" },
      max_tokens: 2000,
      temperature: 0.2,
      messages: enrichMessages,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenRouter error ${res.status}: ${err.error?.message ?? "unknown"}`);
  }
  const data = await res.json();
  const latency = (Date.now() - start) / 1000;

  if (posthog && traceId) {
    posthog.capture({
      distinctId: profileId,
      event: "$ai_generation",
      properties: {
        $ai_trace_id: traceId,
        $ai_span_id: randomUUID(),
        $ai_parent_id: pipelineSpanId,
        $ai_span_name: "enrich-references",
        $ai_model: data.model ?? "google/gemini-2.5-flash",
        $ai_provider: "google",
        $ai_input: enrichMessages,
        $ai_output_choices: [{ role: "assistant", content: data.choices?.[0]?.message?.content }],
        $ai_input_tokens: data.usage?.prompt_tokens,
        $ai_output_tokens: data.usage?.completion_tokens,
        $ai_total_cost_usd: data.usage?.cost,
        $ai_latency: latency,
        $ai_base_url: "https://openrouter.ai/api/v1",
      },
    });
  }

  try {
    const { refs } = JSON.parse(data.choices[0].message.content);
    return Array.isArray(refs) ? refs : [];
  } catch {
    return names.map((n) => ({ name: n, query: n })); // fallback: keep all with identity query
  }
}

// ── Exa search ────────────────────────────────────────────────────────────────
// Returns { candidates, error } — never silently null on failure.
async function exaSearch(exa, query) {
  try {
    // 3 candidates per reference gives validate-references.mjs fallback options without a second Exa call
    const response = await exa.search(query, {
      numResults: 3,
      type: "auto", // explicit default — Exa changed auto to default in 2024, being explicit for clarity
      excludeDomains: [
        "linkedin.com", // prefer official bios, publisher pages, or editorial articles
        "google.com", // avoid Google redirect/search URLs
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
    results.push(...(await Promise.all(items.slice(i, i + batchSize).map(fn))));
  }
  return results;
}

// ── exported run function ─────────────────────────────────────────────────────
export async function run(briefPath, { outputDir, posthog = null, profileId = null, traceId = null, pipelineSpanId = null } = {}) {
  // ── env check ───────────────────────────────────────────────────────────────
  for (const key of ["OPENROUTER_API_KEY", "EXA_API_KEY"]) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  const exa = new Exa(process.env.EXA_API_KEY);
  outputDir = outputDir ?? path.join(process.cwd(), "briefs");

  const markdown = readFileSync(briefPath, "utf-8");
  const names = parseReferences(markdown);
  if (names.length === 0) {
    console.error("No REFERENCES section found in input.");
    return { referencesJsonPath: null };
  }

  console.error(`Found ${names.length} references. Filtering and normalizing via AI...`);
  let filtered = await filterAndNormalize(names, { posthog, profileId, traceId, pipelineSpanId });
  console.error(`→ ${filtered.length}/${names.length} kept`);

  if (filtered.length > 50) {
    console.error(`WARNING: ${filtered.length} references found, capping at 50`);
    filtered = filtered.slice(0, 50);
  }

  if (filtered.length === 0) {
    console.error("All references filtered out — nothing to write.");
    return { referencesJsonPath: null };
  }

  console.error("Fetching candidates via Exa...");
  const resolved = await batchedAll(filtered, async ({ name, query }) => {
    const { candidates, error } = await exaSearch(exa, query);
    if (error && !candidates.length) console.error(`  ⚠ "${name}": ${error}`);
    return { name, candidates };
  });
  const found = resolved.filter((r) => r.candidates.length > 0).length;
  console.error(`→ ${found}/${resolved.length} with candidates`);

  // Strip "-output" suffix so "abc123-output.md" → "abc123-references.json" not "abc123-output-references.json"
  const stem = path.basename(briefPath, path.extname(briefPath));
  const podcastID = stem.replace(/-output.*$/, "");
  mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${podcastID}-references.json`);
  writeFileSync(outPath, JSON.stringify(resolved, null, 2), "utf-8");
  console.error(`✓ Written to ${outPath}`);

  return { referencesJsonPath: outPath };
}

// ── CLI shim ──────────────────────────────────────────────────────────────────
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/enrich-references.mjs <extract-wisdom-output.md>");
    process.exit(1);
  }
  run(inputPath).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
