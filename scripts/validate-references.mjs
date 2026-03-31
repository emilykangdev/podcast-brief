import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { chromium } from "playwright-core";
import Browserbase from "@browserbasehq/sdk";

// ── env check ─────────────────────────────────────────────────────────────────
for (const key of ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"]) {
  if (!process.env[key]) { console.error(`Missing required env var: ${key}`); process.exit(1); }
}

// ── input arg + filename guard ────────────────────────────────────────────────
const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/validate-references.mjs <podcastID-references.json>");
  process.exit(1);
}
const ext = path.extname(inputPath);
const stem = path.basename(inputPath, ext);
if (ext !== ".json" || !stem.endsWith("-references")) {
  console.error(`Error: input must be a *-references.json file (got: ${path.basename(inputPath)})`);
  process.exit(1);
}
const podcastID = stem.replace(/-references$/, "");

// ── validate a single URL ─────────────────────────────────────────────────────
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
  for (let i = 1; i < pages.length; i++) await pages[i].close(); // close any extras
  return pages[0];
}

// ── main ──────────────────────────────────────────────────────────────────────
// File existence: readFileSync throws with a decent message if file is missing,
// but catch and re-throw with usage hint for clarity.
let refs;
try {
  refs = JSON.parse(readFileSync(inputPath, "utf-8"));
} catch (e) {
  console.error(`Error: cannot read input file: ${e.message}`);
  console.error(`Usage: node scripts/validate-references.mjs <podcastID-references.json>`);
  process.exit(1);
}
if (!Array.isArray(refs)) {
  console.error("Error: input JSON must be an array");
  process.exit(1);
}
console.error(`Validating ${refs.length} references via Browserbase...`);

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
const results = [];
let browser;
try {
  const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
  browser = await chromium.connectOverCDP(session.connectUrl);
  for (const ref of refs) {
    if (!ref.candidates.length) {
      results.push({ name: ref.name, url: null });
      continue;
    }
    let found = null;
    let sessionDead = false;
    for (const url of ref.candidates) {
      // Enforce one tab before each candidate — closes any extras that accumulated
      // (e.g. YouTube opening a popup) and recovers if the page closed entirely.
      const page = await ensureSinglePage(browser);
      let { valid, reason } = await validateUrl(page, url);

      // "has been closed" means the page closed during navigation, not that the URL is bad.
      // Enforce one tab again and retry that specific URL once before giving up.
      if (reason?.includes("has been closed")) {
        console.error(`    ↺ ${url} (page closed mid-navigation, retrying...)`);
        const freshPage = await ensureSinglePage(browser);
        ({ valid, reason } = await validateUrl(freshPage, url));
      }

      if (reason?.includes("Target closed") || reason?.includes("Session expired") || reason?.includes("Protocol error") || reason?.includes("Connection closed")) {
        sessionDead = true;
        results.push({ name: ref.name, url: null }); // keep results complete before breaking
        // Structured JSON log to stdout — Railway indexes this for filtering/alerting
        console.log(JSON.stringify({
          level: "error",
          message: "Browserbase session died mid-run",
          podcastID,
          referenceIndex: results.length, // 1-based index of the failing ref (pushed above, so length === index)
          referenceTotal: refs.length,
          reference: ref.name,
          candidateIndex: ref.candidates.indexOf(url) + 1, // which URL was being tried (1 = first, 2 = second, 3 = third)
          candidateTotal: ref.candidates.length,           // how many candidate URLs this reference had (1–3)
          reason,
          skipped: refs.length - results.length, // current ref already pushed above
          action: "rerun validate-references.mjs to retry",
        }));
        break;
      }
      if (valid) { found = url; break; }
      console.error(`    ✗ ${url} (${reason})`);
    }
    if (sessionDead) break; // break outer for loop too
    if (found) {
      console.error(`  ✓ ${ref.name}`);
      results.push({ name: ref.name, url: found });
    } else {
      console.error(`  ✗ ${ref.name} (all candidates failed)`);
      results.push({ name: ref.name, url: null });
    }
  }
} finally {
  await browser?.close();
}

const validated = results.filter((r) => r.url).length;
console.error(`→ ${validated}/${results.length} validated`);

// ── write markdown for merge-references.mjs ───────────────────────────────────
const lines = results.map((r) => r.url ? `- [${r.name}](${r.url})` : `- ${r.name}`);
const output = `# Enriched References\n\n${lines.join("\n")}\n`;

// Output path derived from input path — works with absolute paths from a backend server.
// Avoids process.cwd() dependency; output always lands beside the input .json file.
// NOTE: enrich-references.mjs still uses process.cwd()/briefs — that's a local-only script.
const outPath = path.join(path.dirname(path.resolve(inputPath)), `${podcastID}-references.md`);
try {
  writeFileSync(outPath, output, "utf-8");
} catch (e) {
  console.error(`Error: cannot write output file: ${e.message}`);
  process.exit(1);
}
console.error(`✓ Written to ${outPath}`);
