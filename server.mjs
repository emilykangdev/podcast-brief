import express from "express";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { createClient } from "@supabase/supabase-js";
import { run as transcribe } from "./scripts/transcribe.mjs";
import { run as generateBrief, BriefExistsError } from "./scripts/generate-brief.mjs";
import { run as enrichReferences } from "./scripts/enrich-references.mjs";
import { run as validateReferences } from "./scripts/validate-references.mjs";
import { run as mergeReferences } from "./scripts/merge-references.mjs";
import { briefHasAllSections, briefHasReferences } from "./scripts/validate_pipeline.mjs";

// ── Logging ───────────────────────────────────────────────────────────────────
function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function logError(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

// Retry prompt additions keyed by validation failure type
const RETRY_PROMPTS = {
  noReferences:
    "Ensure the brief includes a REFERENCES section with at least one real, citable reference mentioned in the episode. Do not hallucinate references.",
  missingSections:
    "Ensure the brief includes all required sections (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS) with substantive content in each.",
};

// Supabase client at module scope — fails fast at boot if env vars missing
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const app = express();
app.use(express.json());

// Auth — reject any request without the shared secret
app.use((req, res, next) => {
  if (req.headers.authorization !== `Bearer ${process.env.WORKER_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

app.get("/status", async (req, res) => {
  const { data, error } = await supabase
    .from("briefs")
    .select("id, input_url, created_at")
    .eq("status", "generating")
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ activeJobs: data.length, jobs: data });
});

app.post("/jobs/brief", (req, res) => {
  const { episodeUrl, profileId } = req.body;
  if (!episodeUrl || !profileId) {
    return res.status(400).json({ error: "episodeUrl and profileId required" });
  }
  res.json({ status: "queued" });
  // Fire and forget — errors logged but don't crash the server
  runPipeline(episodeUrl, profileId).catch((err) => logError(`[pipeline error] ${err.message}`));
});

// Closes out a brief row regardless of outcome. Pass output_markdown + references on success;
// omit them on failure — the row still flips to "complete" so the user isn't left hanging.
async function completeBrief(
  briefId,
  { outputMarkdown = null, references = null, errorLog = null } = {}
) {
  await supabase
    .from("briefs")
    .update({
      status: "complete",
      completed_at: new Date().toISOString(),
      ...(outputMarkdown !== null && { output_markdown: outputMarkdown }),
      ...(references !== null && { references }),
      ...(errorLog !== null && { error_log: errorLog }),
    })
    .eq("id", briefId);
}

// Sends a webhook alert to the developer on pipeline failure or degradation.
async function alertDeveloper({ briefId, jobId, error, episodeUrl, context }) {
  if (!process.env.WEBHOOK_URL) return;
  await fetch(process.env.WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      briefId,
      jobId,
      error,
      episodeUrl,
      context,
      timestamp: new Date().toISOString(),
    }),
  }).catch((err) => logError(`[webhook error] ${err.message}`));
}

// Generates a brief and validates it, retrying once with a targeted prompt if sections or
// references are missing. On second failure, patches a placeholder REFERENCES section so the
// pipeline can continue rather than hard-failing.
async function generateBriefWithValidation({
  transcriptId,
  transcriptPath,
  profileId,
  outputDir,
  errorLog,
}) {
  let { briefId, outputPath, outputMd } = await generateBrief({
    transcriptId,
    transcriptPath,
    profileId,
    outputDir,
  });

  const sectionsCheck = briefHasAllSections(outputMd);
  const refsCheck = briefHasReferences(outputMd);
  if (sectionsCheck.valid && refsCheck.valid) return { briefId, outputPath, outputMd };

  const reasons = [sectionsCheck, refsCheck].filter((c) => !c.valid).map((c) => c.reason);
  const promptAddition = !refsCheck.valid
    ? RETRY_PROMPTS.noReferences
    : RETRY_PROMPTS.missingSections;
  errorLog.push({ step: "validate-output", attempt: 1, reasons });
  logError(`[retry] Brief validation failed: ${reasons.join("; ")} — retrying generateBrief`);

  ({ briefId, outputPath, outputMd } = await generateBrief({
    transcriptId,
    transcriptPath,
    profileId,
    force: true,
    promptAddition,
    outputDir,
  }));

  const refsCheck2 = briefHasReferences(outputMd);
  if (!refsCheck2.valid) {
    errorLog.push({ step: "validate-output", attempt: 2, reason: refsCheck2.reason });
    outputMd += "\n\n## REFERENCES\n\nNo references found.\n";
    const { writeFileSync } = await import("fs");
    writeFileSync(outputPath, outputMd, "utf-8");
  }

  return { briefId, outputPath, outputMd };
}

async function runPipeline(episodeUrl, profileId) {
  const jobId = randomUUID();
  const jobDir = path.join(os.tmpdir(), `podcast-brief-${jobId}`);
  await mkdir(jobDir, { recursive: true });
  const errorLog = [];

  let briefId = null;
  try {
    const { episodeId, transcriptPath } = await transcribe(episodeUrl, { outputDir: jobDir });

    const {
      briefId: bid,
      outputPath,
      outputMd,
    } = await generateBriefWithValidation({
      transcriptId: episodeId,
      transcriptPath,
      profileId,
      outputDir: jobDir,
      errorLog,
    });
    briefId = bid;

    const { referencesJsonPath } = await enrichReferences(outputPath, { outputDir: jobDir });

    let finalBriefMd = outputMd;
    let referencesJson = null;

    if (referencesJsonPath) {
      const { referencesMdPath, referencesJson: validated } =
        await validateReferences(referencesJsonPath);
      referencesJson = validated;
      ({ finalBriefMd } = await mergeReferences({
        briefPath: outputPath,
        referencesPath: referencesMdPath,
        outputDir: jobDir,
      }));
    }

    await completeBrief(briefId, {
      outputMarkdown: finalBriefMd,
      references: referencesJson,
      errorLog: errorLog.length > 0 ? errorLog : null,
    });

    if (errorLog.length > 0) {
      await alertDeveloper({
        briefId,
        jobId,
        error: "Pipeline completed with degradation",
        episodeUrl,
        context: errorLog,
      });
    }

    log(`[pipeline] complete [job=${jobId}]${errorLog.length > 0 ? " (degraded)" : ""}`);
  } catch (err) {
    logError(`[pipeline error] ${err.message}`);
    errorLog.push({ step: "unrecoverable", error: err.message, stack: err.stack });

    if (briefId) {
      await completeBrief(briefId, { errorLog }).catch((e) =>
        logError("[cleanup] Failed to update brief status:", e.message)
      );
    }
    await alertDeveloper({ briefId, jobId, error: err.message, episodeUrl, context: errorLog });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch((e) =>
      logError("[cleanup] Failed to remove job dir:", e.message)
    );
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log(`Worker listening on port ${PORT}`));
