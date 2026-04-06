import express from "express";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { mkdir, rm } from "fs/promises";
import supabase from "./libs/supabase/admin.mjs";
import { run as transcribe } from "./scripts/transcribe.mjs";
import { run as generateBrief } from "./scripts/generate-brief.mjs";
import { run as enrichReferences } from "./scripts/enrich-references.mjs";
import { run as validateReferences } from "./scripts/validate-references.mjs";
import { run as mergeReferences } from "./scripts/merge-references.mjs";
import { briefHasAllSections, briefHasReferences } from "./scripts/validate_pipeline.mjs";
import { cleanUrl } from "./libs/url.mjs";

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";
const STALE_JOB_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

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

const app = express();
app.use(express.json());

// Health check — must be before auth middleware so Railway can reach it unauthenticated
app.get("/status", async (req, res) => {
  const { data: generating, error } = await supabase
    .from("briefs")
    .select("id, created_at")
    .eq("status", "generating")
    .eq("environment", APP_ENV)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const { data: queued, error: queuedError } = await supabase
    .from("briefs")
    .select("id, created_at")
    .eq("status", "queued")
    .eq("environment", APP_ENV)
    .order("created_at", { ascending: true });

  if (queuedError) return res.status(500).json({ error: queuedError.message });

  res.json({
    activeJobs: generating.length,
    queuedJobs: queued.length,
    jobs: generating,
    queued,
  });
});

// Closes out a brief row regardless of outcome. Pass output_markdown + references on success;
// omit them on failure — the row still flips to "complete" so the user isn't left hanging.
async function completeBrief(
  briefId,
  { outputMarkdown = null, references = null, errorLog = null } = {}
) {
  const { error } = await supabase
    .from("briefs")
    .update({
      status: "complete",
      completed_at: new Date().toISOString(),
      ...(outputMarkdown !== null && { output_markdown: outputMarkdown }),
      ...(references !== null && { references }),
      ...(errorLog !== null && { error_log: errorLog }),
    })
    .eq("id", briefId);

  if (error) {
    logError(`Failed to complete brief ${briefId}:`, error.message);
  }
}

// Sends a webhook alert to the developer on pipeline failure or degradation.
async function alertDeveloper({ briefId, jobId, error, episodeUrl, context }) {
  if (!process.env.WEBHOOK_URL) return;
  await fetch(cleanUrl("WEBHOOK_URL"), {
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
  briefId,
  outputDir,
  errorLog,
}) {
  let { outputPath, outputMd } = await generateBrief({
    transcriptId,
    transcriptPath,
    profileId,
    briefId,
    outputDir,
  });

  const sectionsCheck = briefHasAllSections(outputMd);
  const refsCheck = briefHasReferences(outputMd);
  if (sectionsCheck.valid && refsCheck.valid) return { outputPath, outputMd };

  const reasons = [sectionsCheck, refsCheck].filter((c) => !c.valid).map((c) => c.reason);
  const promptAddition = !refsCheck.valid
    ? RETRY_PROMPTS.noReferences
    : RETRY_PROMPTS.missingSections;
  errorLog.push({ step: "validate-output", attempt: 1, reasons });
  logError(`[retry] Brief validation failed: ${reasons.join("; ")} — retrying generateBrief`);

  ({ outputPath, outputMd } = await generateBrief({
    transcriptId,
    transcriptPath,
    profileId,
    briefId,
    force: true,
    promptAddition,
    outputDir,
  }));

  const refsCheck2 = briefHasReferences(outputMd);
  if (!refsCheck2.valid) {
    errorLog.push({ step: "validate-output", attempt: 2, reason: refsCheck2.reason });
    outputMd += "\n\n## REFERENCES\n\nNo references found.\n";
    writeFileSync(outputPath, outputMd, "utf-8");
  }

  return { outputPath, outputMd };
}

async function runPipeline(episodeUrl, profileId, briefId) {
  const jobId = randomUUID();
  const jobDir = path.join(os.tmpdir(), `podcast-brief-${jobId}`);
  await mkdir(jobDir, { recursive: true });
  const errorLog = [];

  try {
    const { episodeId, transcriptPath } = await transcribe(episodeUrl, { outputDir: jobDir });

    const { outputPath, outputMd } = await generateBriefWithValidation({
      transcriptId: episodeId,
      transcriptPath,
      profileId,
      briefId,
      outputDir: jobDir,
      errorLog,
    });

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

    await completeBrief(briefId, { errorLog }).catch((e) =>
      logError("[cleanup] Failed to update brief status:", e.message)
    );
    await alertDeveloper({ briefId, jobId, error: err.message, episodeUrl, context: errorLog });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch((e) =>
      logError("[cleanup] Failed to remove job dir:", e.message)
    );
  }
}

// ── Supabase polling ──────────────────────────────────────────────────────────

async function recoverStaleJobs() {
  const { data, error } = await supabase
    .from("briefs")
    .update({ status: "queued", started_at: null })
    .eq("status", "generating")
    .eq("environment", APP_ENV)
    .lt("started_at", new Date(Date.now() - STALE_JOB_TIMEOUT_MS).toISOString())
    .select("id");
  if (error) logError(`[recovery] Error recovering stale jobs: ${error.message}`);
  if (data?.length) log(`[recovery] Reset ${data.length} stale generating job(s) to queued`);
}

let isProcessing = false;

async function pollForWork() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Find oldest queued job for this environment
    const { data: jobs } = await supabase
      .from("briefs")
      .select("id, input_url, profile_id")
      .eq("status", "queued")
      .eq("environment", APP_ENV)
      .order("created_at", { ascending: true })
      .limit(1);

    if (!jobs?.length) return;
    const job = jobs[0];

    // Atomic claim
    const { data: claimed } = await supabase
      .from("briefs")
      .update({ status: "generating", started_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "queued")
      .select("id, input_url, profile_id");

    if (!claimed?.length) return; // another worker claimed it

    await runPipeline(claimed[0].input_url, claimed[0].profile_id, claimed[0].id);
  } catch (err) {
    logError(`[pipeline error] ${err.message}`);
  } finally {
    isProcessing = false;
  }

  // Immediately check for more work instead of waiting for next interval
  setTimeout(pollForWork, 0);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  log(`Worker listening on port ${PORT} (env: ${APP_ENV})`);
  await recoverStaleJobs();
  setInterval(pollForWork, POLL_INTERVAL_MS);
  pollForWork(); // check immediately on boot
});
