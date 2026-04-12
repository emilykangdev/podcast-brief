import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import supabase from "../libs/supabase/admin.mjs";

// Exit codes:
// 0 — success
// 1 — general error (missing args, missing files, API failure, etc.)

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
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return {
    content: data.choices[0].message.content,
    usage: data.usage ?? {},
    model: data.model ?? "unknown",
    messages,
  };
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
  const start = Date.now();
  const result = await callOpenRouter(SYSTEM, userContent);
  result.latency = (Date.now() - start) / 1000;
  return result;
}

async function mergeChunks(briefTexts) {
  if (briefTexts.length === 1) return null; // short-circuit — no merge needed, caller uses chunk result
  console.error(`  Merging ${briefTexts.length} chunk briefs...`);
  const MERGE_SYSTEM = `You are combining extract_wisdom briefs from ${briefTexts.length} consecutive segments of the same podcast episode into one final brief.

Output the same Markdown sections in this exact order:
SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, CLAIMS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS

MERGING RULES:
- SUMMARY: Write one unified summary covering the full episode arc, not just concatenated segment summaries.
- IDEAS: Keep the best 5 ideas total. Merge near-duplicates into the strongest version. Do not just list all ideas from all segments.
- INSIGHTS: Keep the best 5-7 insights. Same deduplication rules as IDEAS.
- QUOTES: Keep the best 10 quotes total. Prefer verbatim, punchy, standalone quotes. Drop weak or redundant ones.
- HABITS: Keep the best 10-15 habits. Deduplicate. Prefer specific and actionable over vague.
- CLAIMS: Keep all unique claims. Drop exact duplicates only.
- REFERENCES: Merge into one deduplicated list. Keep all unique references.
- ONE-SENTENCE TAKEAWAY: Write one single sentence capturing the entire episode. Do not combine segment takeaways.
- RECOMMENDATIONS: Keep the best 10-15. Deduplicate. Prefer specific and actionable.

IMPORTANT: The output should feel like it came from one coherent pass over the full episode, not like a stitched-together list. Quality over quantity in every section.`;
  const userContent = briefTexts.map((b, i) => `--- Segment ${i + 1} ---\n${b}`).join("\n\n");
  const start = Date.now();
  const result = await callOpenRouter(MERGE_SYSTEM, userContent, { maxTokens: 16000 });
  result.latency = (Date.now() - start) / 1000;
  return result;
}

// ── main export ───────────────────────────────────────────────────────────────
export async function run({
  transcriptId,
  transcriptPath,
  profileId,
  briefId,
  force = false,
  promptAddition = null,
  outputDir,
  posthog = null,
  traceId = null,
  pipelineSpanId = null,
} = {}) {
  if (!outputDir) outputDir = process.cwd();

  // ── node version check
  if (parseInt(process.versions.node) < 18) {
    throw new Error("Node 18+ required");
  }

  // ── env checks
  for (const key of ["OPENROUTER_API_KEY"]) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  // ── arg checks
  if (!transcriptId || !transcriptPath || !profileId) {
    throw new Error("transcriptId, transcriptPath, and profileId are required");
  }
  if (!briefId) throw new Error("briefId is required");
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

  console.error("Generating brief...");

  const chunks = chunkTranscript(transcript);
  if (chunks.length > 1) console.error(`  → ${chunks.length} chunks`);

  const chunkResults = await Promise.all(
    chunks.map((chunk, i) => extractChunk(SYSTEM, chunk, i, chunks.length, promptAddition))
  );

  // Emit $ai_generation for each chunk extraction
  if (posthog && traceId) {
    for (let i = 0; i < chunkResults.length; i++) {
      const r = chunkResults[i];
      posthog.capture({
        distinctId: profileId,
        event: "$ai_generation",
        properties: {
          $ai_trace_id: traceId,
          $ai_span_id: randomUUID(),
          $ai_parent_id: pipelineSpanId,
          $ai_span_name: chunks.length > 1 ? `extract-chunk-${i + 1}` : "extract-brief",
          $ai_model: r.model,
          $ai_provider: "anthropic",
          $ai_input: r.messages,
          $ai_output_choices: [{ role: "assistant", content: r.content }],
          $ai_input_tokens: r.usage.prompt_tokens,
          $ai_output_tokens: r.usage.completion_tokens,
          $ai_total_cost_usd: r.usage.cost,
          $ai_latency: r.latency,
          $ai_base_url: "https://openrouter.ai/api/v1",
        },
      });
    }
  }

  // Merge if multi-chunk, otherwise use the single result
  const mergeResult = await mergeChunks(chunkResults.map((r) => r.content));
  const brief = mergeResult ? mergeResult.content : chunkResults[0].content;

  // Emit $ai_generation for merge step (only if multi-chunk)
  if (posthog && traceId && mergeResult) {
    posthog.capture({
      distinctId: profileId,
      event: "$ai_generation",
      properties: {
        $ai_trace_id: traceId,
        $ai_span_id: randomUUID(),
        $ai_parent_id: pipelineSpanId,
        $ai_span_name: "merge-chunks",
        $ai_model: mergeResult.model,
        $ai_provider: "anthropic",
        $ai_input: mergeResult.messages,
        $ai_output_choices: [{ role: "assistant", content: mergeResult.content }],
        $ai_input_tokens: mergeResult.usage.prompt_tokens,
        $ai_output_tokens: mergeResult.usage.completion_tokens,
        $ai_total_cost_usd: mergeResult.usage.cost,
        $ai_latency: mergeResult.latency,
        $ai_base_url: "https://openrouter.ai/api/v1",
      },
    });
  }

  // write file
  mkdirSync(outputDir, { recursive: true });
  let version = 1;
  while (existsSync(join(outputDir, `${transcriptId}-output-v${version}.md`))) version++;
  const outputPath = join(outputDir, `${transcriptId}-output-v${version}.md`);
  const disclaimer = `> Disclaimer: Speaker accreditation may not be 100% correct. Please confirm references — they are a starting point.\n\n`;
  writeFileSync(outputPath, disclaimer + brief, "utf-8");
  console.error(`✓ Brief written to ${outputPath}`);

  // update brief row — crash insurance: persist output_markdown while status stays 'generating'
  // server.mjs is responsible for transitioning status to 'complete' via completeBrief().
  // When called from CLI (briefId is a UUID placeholder), this UPDATE is a no-op.
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
// NOTE: briefId is required when called from the server (the API route creates the row first).
// For direct CLI usage, a UUID placeholder is generated — the UPDATE above will be a no-op
// since no row with that ID exists.

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
  const briefId = randomUUID();
  run({ transcriptId, transcriptPath, profileId, briefId, force }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
