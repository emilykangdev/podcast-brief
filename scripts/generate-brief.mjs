import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { createClient } from "@supabase/supabase-js";

// Exit codes:
// 0 — success
// 1 — general error (missing args, missing files, API failure, etc.)
// 2 — brief already exists for this (profile_id, input_url) — HTTP wrapper maps to 409

export class BriefExistsError extends Error {}

// A "generating" row older than this is assumed to be from a crashed run and will be replaced.
const STALE_GENERATING_TIMEOUT_MS = 5 * 60 * 1000;

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
  if (!data.choices?.length)
    throw new Error(`OpenRouter returned no choices: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

// ── chunking ──────────────────────────────────────────────────────────────────
const CHUNK_CHAR_SIZE = 400_000; // ~100K tokens, leaves room for system prompt + output

function chunkTranscript(text) {
  if (text.length <= CHUNK_CHAR_SIZE) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_CHAR_SIZE) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.slice(0, CHUNK_CHAR_SIZE);
    const lastTurn = slice.lastIndexOf("\n\n**["); // turns are separated by \n\n in transcribe.mjs
    if (lastTurn < 0)
      console.error(
        `  Warning: no turn boundary found in chunk ${chunks.length + 1}, splitting at char limit`
      );
    const splitAt = lastTurn >= 0 ? lastTurn : CHUNK_CHAR_SIZE;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// ── extraction ────────────────────────────────────────────────────────────────
async function extractChunk(SYSTEM, chunkText, index, total, promptAddition) {
  const label = total > 1 ? ` (chunk ${index + 1}/${total})` : "";
  console.error(`  Extracting${label}...`);
  let userContent = `Transcript${total > 1 ? ` segment ${index + 1} of ${total}` : ""}:\n${chunkText}`;
  if (promptAddition != null) {
    userContent += `\n\nAdditional instruction: ${promptAddition}`;
  }
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

// Throws BriefExistsError if a non-stale brief already exists.
// Deletes stale or force-replaced rows so the caller can insert a fresh one.
async function resolveExistingBrief(existing, { force, supabase }) {
  if (!existing) return;
  if (force) {
    console.error(`--force: deleting existing ${existing.status} row and regenerating...`);
    await supabase.from("briefs").delete().eq("id", existing.id);
    return;
  }
  if (existing.status === "complete") {
    throw new BriefExistsError("Brief already exists (complete) — skipping generation");
  }
  // status === "generating" — check if stale (older than STALE_GENERATING_TIMEOUT_MS = crashed run)
  const ageMs = Date.now() - new Date(existing.updated_at).getTime();
  if (ageMs < STALE_GENERATING_TIMEOUT_MS) {
    throw new BriefExistsError("Brief is currently generating — try again shortly");
  }
  console.error("Stale generating row found (crashed run) — retrying...");
  await supabase.from("briefs").delete().eq("id", existing.id);
}

// ── main export ───────────────────────────────────────────────────────────────
export async function run({
  transcriptId,
  transcriptPath,
  profileId,
  force = false,
  promptAddition = null,
  outputDir,
} = {}) {
  if (!outputDir) outputDir = process.cwd();

  // ── node version check
  if (parseInt(process.versions.node) < 18) {
    throw new Error("Node 18+ required");
  }

  // ── env checks
  for (const key of ["OPENROUTER_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  // ── arg checks
  if (!transcriptId || !transcriptPath || !profileId) {
    throw new Error("transcriptId, transcriptPath, and profileId are required");
  }
  if (!transcriptPath.endsWith(".md")) {
    throw new Error("Error: transcript must be a .md file");
  }
  if (!existsSync(transcriptPath)) {
    throw new Error(`Error: file not found: ${transcriptPath}`);
  }

  // ── load prompt
  const promptPath = join(dirname(fileURLToPath(import.meta.url)), "../prompts/extract_wisdom.md");
  if (!existsSync(promptPath)) {
    throw new Error(`Error: prompt file not found: ${promptPath}`);
  }
  const SYSTEM = readFileSync(promptPath, "utf-8");

  // ── load transcript
  const transcript = readFileSync(transcriptPath, "utf-8");

  // ── client
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );

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
  await resolveExistingBrief(existing, { force, supabase });

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

  const chunkBriefs = await Promise.all(
    chunks.map((chunk, i) => extractChunk(SYSTEM, chunk, i, chunks.length, promptAddition))
  );
  const brief = await mergeChunks(chunkBriefs);

  // write file
  mkdirSync(outputDir, { recursive: true });
  let version = 1;
  while (existsSync(join(outputDir, `${transcriptId}-output-v${version}.md`))) version++;
  const outputPath = join(outputDir, `${transcriptId}-output-v${version}.md`);
  const disclaimer = `> Disclaimer: Speaker accreditation may not be 100% correct. Please confirm references — they are a starting point.\n\n`;
  writeFileSync(outputPath, disclaimer + brief, "utf-8");
  console.error(`✓ Brief written to ${outputPath}`);

  // update brief row
  console.error("  Saving to Supabase...");
  const { error: updateError } = await supabase
    .from("briefs")
    .update({ output_markdown: brief, status: "generating" })
    .eq("id", briefId);
  if (updateError) throw new Error(`Supabase update failed: ${updateError.message}`);
  console.error("✓ Saved to briefs table");

  return { briefId, outputPath, outputMd: disclaimer + brief };
}

// ── CLI shim ──────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--force");
  const [transcriptId, transcriptPath, profileId] = positional;
  if (!transcriptId || !transcriptPath || !profileId) {
    console.error(
      "Usage: node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> <transcript.md> <profileId> [--force]"
    );
    process.exit(1);
  }
  run({ transcriptId, transcriptPath, profileId, force }).catch((err) => {
    console.error(err.message);
    process.exit(err instanceof BriefExistsError ? 2 : 1);
  });
}
