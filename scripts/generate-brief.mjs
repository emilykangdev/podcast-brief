import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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
for (const key of ["OPENROUTER_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ── arg checks ────────────────────────────────────────────────────────────────
// NOTE: episodeDescription must always be passed (use "" as placeholder).
//   profileId is the 5th positional arg — omitting description shifts it to 4th.
const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((a) => a !== "--force");
const [transcriptId, transcriptPath, profileId] = positional;
if (!transcriptId || !transcriptPath || !profileId) {
  console.error('Usage: node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> <transcript.md> <profileId> [--force]');
  console.error('       --force: skip 409 check and delete existing row before regenerating (dev only)');
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

// ── clients ───────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

// ── callOpenRouter ────────────────────────────────────────────────────────────
async function callOpenRouter(system, user, { maxTokens = 16000 } = {}) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "podcast-brief",
    },
    body: JSON.stringify({
      model: "anthropic/claude-opus-4-6",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenRouter error ${res.status}: ${err.error?.message ?? "unknown"}`);
  }
  const data = await res.json();
  if (!data.choices?.length) throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data)}`);
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
  const userContent = `Transcript${total > 1 ? ` segment ${index + 1} of ${total}` : ""}:\n${chunkText}`;
  return callOpenRouter(SYSTEM, userContent);
}

async function mergeChunks(briefs) {
  if (briefs.length === 1) return briefs[0]; // short-circuit — no merge needed
  console.error(`  Merging ${briefs.length} chunk briefs...`);
  const MERGE_SYSTEM = `You are combining extract_wisdom briefs from ${briefs.length} consecutive segments of the same podcast episode into one final brief.

Output the same Markdown sections in this exact order:
SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS

MERGING RULES:
- SUMMARY: Write one unified summary covering the full episode arc, not just concatenated segment summaries.
- IDEAS: Keep the best 5 ideas total. Merge near-duplicates into the strongest version. Do not just list all ideas from all segments.
- INSIGHTS: Keep the best 5-7 insights. Same deduplication rules as IDEAS.
- QUOTES: Keep the best 10 quotes total. Prefer verbatim, punchy, standalone quotes. Drop weak or redundant ones.
- HABITS: Keep the best 10-15 habits. Deduplicate. Prefer specific and actionable over vague.
- FACTS: Keep all unique facts. Drop exact duplicates only.
- REFERENCES: Merge into one deduplicated list. Keep all unique references.
- ONE-SENTENCE TAKEAWAY: Write one single sentence capturing the entire episode. Do not combine segment takeaways.
- RECOMMENDATIONS: Keep the best 10-15. Deduplicate. Prefer specific and actionable.

IMPORTANT: The output should feel like it came from one coherent pass over the full episode, not like a stitched-together list. Quality over quantity in every section.`;
  const userContent = briefs.map((b, i) => `--- Segment ${i + 1} ---\n${b}`).join("\n\n");
  return callOpenRouter(MERGE_SYSTEM, userContent, { maxTokens: 16000 });
}

// ── main ──────────────────────────────────────────────────────────────────────
try {
  console.error("Generating brief...");

  // 409 check — if a complete or in-progress brief already exists, do not generate
  // Frontend should catch this first via direct Supabase query, but backend is authoritative
  const { data: existing } = await supabase
    .from("briefs")
    .select("id, status, updated_at")
    .eq("input_url", transcriptId)
    .eq("profile_id", profileId)
    .in("status", ["complete", "generating"])
    .maybeSingle();
  if (existing) {
    if (force) {
      console.error(`--force: deleting existing ${existing.status} row and regenerating...`);
      await supabase.from("briefs").delete().eq("id", existing.id);
    } else if (existing.status === "complete") {
      console.error("Brief already exists (complete) — skipping generation");
      process.exit(2); // HTTP wrapper maps exit code 2 → 409
    } else {
      // status === "generating" — check if stale (>5 min = crashed run)
      const ageMs = Date.now() - new Date(existing.updated_at).getTime();
      if (ageMs < 5 * 60 * 1000) {
        console.error("Brief is currently generating — try again shortly");
        process.exit(2);
      }
      // stale generating row — delete it and proceed with a fresh run
      console.error("Stale generating row found (crashed run) — retrying...");
      await supabase.from("briefs").delete().eq("id", existing.id);
    }
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
  mkdirSync("briefs", { recursive: true });
  let version = 1;
  while (existsSync(`briefs/${transcriptId}-output-v${version}.md`)) version++;
  const outputFile = `briefs/${transcriptId}-output-v${version}.md`;
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
