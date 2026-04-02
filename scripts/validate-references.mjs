import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";

// ── URL validation ────────────────────────────────────────────────────────────
const ERROR_STRINGS = ["404", "not found", "page not found", "access denied", "forbidden"];

async function validateUrl(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    if (!response || response.status() !== 200) {
      return { valid: false, reason: `HTTP ${response?.status() ?? "no response"}` };
    }
    const title = (await page.title()).toLowerCase();
    const matched = ERROR_STRINGS.find((s) => title.includes(s));
    if (matched) return { valid: false, reason: `title contains "${matched}"` };
    return { valid: true, reason: null };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

// Enforces exactly one tab in the session context and returns it.
// Browserbase explicitly recommends one tab per session — multiple tabs degrade performance.
// Some navigations (e.g. YouTube) open new tabs or close the current one. This closes any
// extras and returns the surviving page, or opens a fresh one if all pages closed.
// (browser.contexts()[0].newPage() is safe; browser.newPage() is NOT — it creates a tab
// outside the recorded session context and breaks Browserbase's stealth features.)
async function ensureSinglePage(browser) {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  if (pages.length === 0) return ctx.newPage();
  for (let i = 1; i < pages.length; i++) await pages[i].close();
  return pages[0];
}

function isSessionDead(reason) {
  return (
    reason?.includes("Target closed") ||
    reason?.includes("Session expired") ||
    reason?.includes("Protocol error") ||
    reason?.includes("Connection closed")
  );
}

// ── Session management ────────────────────────────────────────────────────────
async function connectSession(bb) {
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  return chromium.connectOverCDP(session.connectUrl);
}

// ── Per-URL validation with page-closed retry ─────────────────────────────────
// "has been closed" means the page closed mid-navigation, not that the URL is bad.
// Enforce one tab and retry once before giving up.
async function checkUrl(browser, url) {
  const page = await ensureSinglePage(browser);
  let { valid, reason } = await validateUrl(page, url);
  if (reason?.includes("has been closed")) {
    console.error(`    ↺ ${url} (page closed mid-navigation, retrying...)`);
    const freshPage = await ensureSinglePage(browser);
    ({ valid, reason } = await validateUrl(freshPage, url));
  }
  return { valid, reason };
}

// Tries each candidate URL for a ref. Returns the first valid URL or null.
// Throws SessionDeadError if the Browserbase session dies mid-ref.
class SessionDeadError extends Error {
  constructor({ ref, url, reason }) {
    super("Browserbase session died");
    this.ref = ref;
    this.url = url;
    this.deadReason = reason;
  }
}

async function findValidUrl(browser, ref) {
  for (const url of ref.candidates) {
    const { valid, reason } = await checkUrl(browser, url);
    if (isSessionDead(reason)) throw new SessionDeadError({ ref, url, reason });
    if (valid) return url;
    console.error(`    ✗ ${url} (${reason})`);
  }
  return null;
}

// Validates all refs starting from startIndex, pushing into results.
// Throws SessionDeadError if the session dies.
async function processRefs(browser, refs, startIndex, results) {
  for (let i = startIndex; i < refs.length; i++) {
    const ref = refs[i];
    if (!ref.candidates.length) {
      results.push({ name: ref.name, url: null });
      continue;
    }
    const url = await findValidUrl(browser, ref);
    results.push({ name: ref.name, url });
    console.error(url ? `  ✓ ${ref.name}` : `  ✗ ${ref.name} (all candidates failed)`);
  }
}

// ── Output writing ────────────────────────────────────────────────────────────
function writeResults(
  results,
  inputPath,
  podcastID,
  { partial = false, deadError = null, refs = [] } = {}
) {
  const validated = results.filter((r) => r.url).length;
  const suffix = partial ? " (partial — session died twice)" : "";
  console.error(`→ ${validated}/${results.length} validated${suffix}`);

  const lines = results.map((r) => (r.url ? `- [${r.name}](${r.url})` : `- ${r.name}`));
  const outPath = path.join(path.dirname(path.resolve(inputPath)), `${podcastID}-references.md`);
  writeFileSync(outPath, `# Enriched References\n\n${lines.join("\n")}\n`, "utf-8");
  console.error(`✓ Written to ${outPath}`);

  if (deadError) {
    console.log(
      JSON.stringify({
        level: "error",
        message: "Browserbase session died mid-run (second death, giving up)",
        podcastID,
        referenceIndex: results.length,
        referenceTotal: refs.length,
        reference: deadError.ref.name,
        candidateIndex: deadError.ref.candidates.indexOf(deadError.url) + 1,
        candidateTotal: deadError.ref.candidates.length,
        reason: deadError.deadReason,
        skipped: refs.length - results.length,
        action: "rerun validate-references.mjs to retry",
      })
    );
  }

  return { referencesMdPath: outPath, referencesJson: results };
}

// ── exported run function ─────────────────────────────────────────────────────
export async function run(inputPath) {
  for (const key of ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }

  const ext = path.extname(inputPath);
  const stem = path.basename(inputPath, ext);
  if (ext !== ".json" || !stem.endsWith("-references")) {
    throw new Error(
      `Error: input must be a *-references.json file (got: ${path.basename(inputPath)})`
    );
  }
  const podcastID = stem.replace(/-references$/, "");

  let refs;
  try {
    refs = JSON.parse(readFileSync(inputPath, "utf-8"));
  } catch (e) {
    throw new Error(`Cannot read input file: ${e.message}`);
  }
  if (!Array.isArray(refs)) throw new Error("Input JSON must be an array");
  console.error(`Validating ${refs.length} references via Browserbase...`);

  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const results = [];
  let browser = await connectSession(bb);
  let hasRetried = false;
  let startIndex = 0;

  try {
    while (true) {
      try {
        await processRefs(browser, refs, startIndex, results);
        break; // all refs processed successfully
      } catch (err) {
        if (!(err instanceof SessionDeadError) || hasRetried) {
          return writeResults(results, inputPath, podcastID, {
            partial: true,
            deadError: err instanceof SessionDeadError ? err : null,
            refs,
          });
        }
        hasRetried = true;
        browser.close().catch(() => {});
        browser = await connectSession(bb);
        startIndex = results.length; // resume from the ref that was in-flight
      }
    }
  } finally {
    await browser?.close();
  }

  return writeResults(results, inputPath, podcastID);
}

// ── CLI shim ──────────────────────────────────────────────────────────────────
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: node scripts/validate-references.mjs <podcastID-references.json>");
    process.exit(1);
  }
  run(inputPath).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
