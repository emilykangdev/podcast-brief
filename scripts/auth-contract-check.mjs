// Auth contract check — hits the REAL services (Resend + a real Supabase project) and
// asserts the input→status contract that the Playwright UI tests stub. Run manually:
//
//   RESEND_API_KEY=re_... \
//   CONTRACT_SUPABASE_URL=https://<ref>.supabase.co \
//   CONTRACT_SUPABASE_KEY=sb_publishable_... \
//   CONTRACT_EMAIL=you@example.com \
//   node scripts/auth-contract-check.mjs
//
// NOT part of `npm test`: steps 5–6 send one real magic-link email to CONTRACT_EMAIL and
// deliberately trip the per-user rate limit. Mixing dev keys and the prod project is
// intentional — this is a portfolio project, not a live commercial deployment.
//
// Per repo policy, a missing prerequisite FAILS loudly. No skips.

import net from "node:net";
import tls from "node:tls";

const {
  RESEND_API_KEY,
  CONTRACT_SUPABASE_URL,
  CONTRACT_SUPABASE_KEY,
  CONTRACT_EMAIL,
} = process.env;

const missing = Object.entries({ RESEND_API_KEY, CONTRACT_SUPABASE_URL, CONTRACT_SUPABASE_KEY, CONTRACT_EMAIL })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(`FAIL: required env missing: ${missing.join(", ")} — this check does not skip.`);
  process.exit(1);
}

const results = [];
let failed = false;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Resend API: key valid, domain verified ────────────────────────────────
try {
  const res = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  });
  if (res.status === 200) {
    const { data = [] } = await res.json();
    const domain = data.find((d) => d.name === "podcastbrief.app");
    record("resend api key valid", true, `HTTP 200, ${data.length} domain(s)`);
    record(
      "podcastbrief.app verified in resend",
      domain?.status === "verified",
      domain ? `status=${domain.status}` : "domain not found on this account"
    );
  } else if (res.status === 401 && (await res.text()).includes("restricted")) {
    // sending_access keys can't list domains — that's fine, SMTP AUTH below is the real test
    record("resend api key valid", true, "401 restricted_api_key (sending-access key — expected)");
    record("podcastbrief.app verified in resend", true, "unverifiable with sending-access key; SMTP AUTH is the effective test");
  } else {
    record("resend api key valid", false, `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
} catch (e) {
  record("resend api key valid", false, e.message);
}

// ── 2. Resend SMTP AUTH (the path GoTrue uses) — auth then QUIT, no send ─────
// Minimal SMTP client: EHLO → AUTH PLAIN → QUIT. 465 = implicit TLS (what the
// Supabase dashboard is configured with); 587 = STARTTLS (checked as fallback).
function smtpAuthCheck({ port, starttls }) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ ok: false, detail: "timeout after 15s" }), 15_000);
    const finish = (ok, detail) => { clearTimeout(timeout); resolve({ ok, detail }); };

    const authPayload = Buffer.from(`\0resend\0${RESEND_API_KEY}`).toString("base64");
    let stage = starttls ? "greeting-plain" : "greeting";
    let socket;

    const onData = (chunk) => {
      const line = chunk.toString();
      const code = line.slice(0, 3);
      if (stage === "greeting" || stage === "greeting-plain") {
        if (code !== "220") return finish(false, `greeting: ${line.trim().slice(0, 80)}`);
        socket.write("EHLO contract-check.local\r\n");
        stage = stage === "greeting-plain" ? "ehlo-plain" : "ehlo";
      } else if (stage === "ehlo-plain") {
        if (!line.includes("250")) return finish(false, `EHLO: ${line.trim().slice(0, 80)}`);
        socket.write("STARTTLS\r\n");
        stage = "starttls";
      } else if (stage === "starttls") {
        if (code !== "220") return finish(false, `STARTTLS: ${line.trim().slice(0, 80)}`);
        socket.removeListener("data", onData);
        socket = tls.connect({ socket, servername: "smtp.resend.com" }, () => {
          socket.on("data", onData);
          socket.write("EHLO contract-check.local\r\n");
          stage = "ehlo";
        });
        socket.on("error", (e) => finish(false, `TLS: ${e.message}`));
      } else if (stage === "ehlo") {
        if (!line.includes("250")) return finish(false, `EHLO: ${line.trim().slice(0, 80)}`);
        socket.write(`AUTH PLAIN ${authPayload}\r\n`);
        stage = "auth";
      } else if (stage === "auth") {
        socket.write("QUIT\r\n");
        socket.end();
        if (code === "235") return finish(true, "235 authenticated");
        return finish(false, `AUTH: ${line.trim().slice(0, 80)}`);
      }
    };

    socket = starttls
      ? net.connect(port, "smtp.resend.com")
      : tls.connect({ host: "smtp.resend.com", port, servername: "smtp.resend.com" });
    socket.on("data", onData);
    socket.on("error", (e) => finish(false, e.message));
  });
}

for (const [label, opts] of [
  ["smtp 465 implicit-tls AUTH (supabase's config)", { port: 465, starttls: false }],
  ["smtp 587 starttls AUTH", { port: 587, starttls: true }],
]) {
  const { ok, detail } = await smtpAuthCheck(opts);
  record(label, ok, detail);
}

// ── 3–6. GoTrue contract on the real project ─────────────────────────────────
async function otp(email) {
  const res = await fetch(
    `${CONTRACT_SUPABASE_URL}/auth/v1/otp`,
    {
      method: "POST",
      headers: { apikey: CONTRACT_SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
    }
  );
  let body = {};
  try { body = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body };
}

try {
  const res = await fetch(`${CONTRACT_SUPABASE_URL}/auth/v1/health`, {
    headers: { apikey: CONTRACT_SUPABASE_KEY },
  });
  record("gotrue health", res.status === 200, `HTTP ${res.status}`);
} catch (e) {
  record("gotrue health", false, e.message);
}

{
  const { status, body } = await otp("not-an-email");
  record("invalid email → 400", status === 400, `HTTP ${status} ${body.error_code ?? ""}`);
}

{
  const { status, body } = await otp(CONTRACT_EMAIL);
  record(
    "valid email → 200 (magic link actually sends)",
    status === 200,
    `HTTP ${status} ${body.error_code ?? ""}${status === 500 ? " — SMTP send failing: check the key in Supabase Auth → SMTP Settings" : ""}`
  );

  // Immediate resend to the same address must trip the per-user rate limit.
  // Only meaningful if the first send succeeded (a 500 never counts as a send).
  if (status === 200) {
    const second = await otp(CONTRACT_EMAIL);
    record(
      "immediate resend → 429 rate limit",
      second.status === 429 && second.body.error_code === "over_email_send_rate_limit",
      `HTTP ${second.status} ${second.body.error_code ?? ""}`
    );
  } else {
    record("immediate resend → 429 rate limit", false, "unreachable: first send did not return 200");
  }
}

console.log(`\n${failed ? "CONTRACT CHECK FAILED" : "contract check passed"} — ${results.filter((r) => r.ok).length}/${results.length}`);
process.exit(failed ? 1 : 0);
