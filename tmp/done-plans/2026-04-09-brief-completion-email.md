# Plan: Brief Completion Email

## Goal

After a brief finishes generating with usable content, send the user exactly one email containing the brief rendered as HTML, with the raw markdown attached as a `.md` file and a link to the dashboard at the top.

## Why

- Users shouldn't have to keep the dashboard open polling to know when their brief is ready
- Email delivery is already promised in the pricing page ("Sent to your email inbox")
- The `brief_email_deliveries` table and Resend integration already exist — this wires them together

## What

When `runPipeline()` completes successfully with non-null `outputMarkdown`:
1. Look up the user's email from `profiles`
2. Atomically INSERT into `brief_email_deliveries` — unique index on `brief_id` ensures only one row per brief. If the INSERT fails (row already exists), stop. This is the idempotency guard: the database is the single source of truth.
3. Convert `output_markdown` to email-safe HTML via `marked` with a custom renderer + `juice`
4. Send via Resend with the raw markdown as a `.md` attachment (Resend natively supports `attachments: [{ filename, content }]`, max 40MB total)
5. UPDATE the delivery row to `sent` with `provider_message_id`

### Success Criteria

- [ ] Email sent exactly once per successful brief (idempotency via `brief_email_deliveries`)
- [ ] Email renders correctly in Gmail (web), Outlook, Apple Mail (inline styles, table layout)
- [ ] Raw markdown attached as `.md` file
- [ ] Dashboard link at top of email
- [ ] Subject: "Your brief is ready: {episode_title}" (fallback: "Your brief is ready")
- [ ] No email sent when `outputMarkdown` is null
- [ ] Pipeline doesn't crash if email sending fails (fire-and-forget with error logging)

## Files Being Changed

```
libs/
  resend.js               ← MODIFIED  (add optional attachments param to sendEmail)
  email/
    briefEmail.mjs        ← NEW  (markdown→HTML renderer + email template + send function)
server.mjs                ← MODIFIED  (call sendBriefEmail after completeBrief success path)
config.js                 ← MODIFIED  (domainName from NEXT_PUBLIC_DOMAIN_NAME env var)
package.json              ← MODIFIED  (add marked, juice)
README.md                 ← MODIFIED  (document email notification + future improvement note)
supabase/migrations/
  20260409000000_add_brief_email_unique_idx.sql  ← NEW  (unique index on brief_id for idempotency)
```

## Architecture Overview

```
runPipeline() success path (server.mjs:199-203)
  └─ completeBrief()          ← existing, no changes
  └─ sendBriefEmail()         ← NEW, awaited but non-blocking (errors caught, don't crash pipeline)
       ├─ lookup profile.email via supabase admin client
       ├─ idempotency: INSERT into brief_email_deliveries with unique index on brief_id (skip if exists)
       ├─ render markdown → email HTML (marked custom renderer + juice)
       ├─ call Resend API with HTML body + .md attachment
       └─ UPDATE brief_email_deliveries to 'sent' with provider_message_id
```

## All Needed Context

### Documentation & References

```yaml
- file: libs/resend.js
  why: Existing sendEmail() helper. Add optional `attachments` param so briefEmail.mjs can use it instead of creating a separate Resend client.

- file: config.js (lines 67-74)
  why: resend.fromNoReply is the sender for automated emails. domainName (line 8) now reads from NEXT_PUBLIC_DOMAIN_NAME env var — set per environment in Vercel/Railway.

- file: server.mjs (lines 199-215)
  why: The success path where we insert the sendBriefEmail() call. completeBrief at line 199, degradation alert at line 205.

- file: supabase/migrations/20260307135000_create_brief_email_deliveries_table.sql
  why: Schema for delivery tracking. Key columns: brief_id, profile_id, provider, status, provider_message_id, error, sent_at

- file: libs/supabase/admin.mjs
  why: Service-role Supabase client used by the worker. Bypasses RLS.
```

### Known Gotchas

```
1. Resend attachment format (confirmed via Context7):
   { filename: "brief.md", content: Buffer.from(markdownString) }
   Max 40MB total. Not supported with batch sending.

3. marked custom renderer: child tokens must be parsed with
   this.parser.parseInline(tokens) for inline content,
   this.parser.parse(tokens) for block content.

4. Gmail strips <style> blocks — all styles must be inline on elements.

5. Outlook uses Word engine — use <table> for layout, not flexbox/grid.

6. Gmail clips emails over 102KB HTML. Briefs are typically 3-8KB markdown,
   so rendered HTML with inline styles should be well under this.

7. The worker uses the admin supabase client (service role) which bypasses
   RLS. The brief_email_deliveries table has RLS enabled but that won't
   affect our inserts/updates from the worker.

8. Use config.resend.fromNoReply for the sender (automated notification).

9. Use relative imports in .mjs files (not @/config). server.mjs runs via
   `node server.mjs` — no Next.js module resolution, so @/ won't resolve.
```

## Implementation Blueprint

### Task 1: Install dependencies

```bash
npm install marked juice
```

### Task 2: Update `config.js` — domainName from env var

```javascript
// Change line 8 from:
domainName: "not-yet",
// To:
domainName: process.env.NEXT_PUBLIC_DOMAIN_NAME || "localhost:3000",
```

Set `NEXT_PUBLIC_DOMAIN_NAME=podcast-brief.vercel.app` in Vercel (production) and Railway.
Dev gets `localhost:3000` fallback. Each environment gets its own dashboard link.

### Task 3: Add unique index migration for idempotency

Create `supabase/migrations/20260409000000_add_brief_email_unique_idx.sql`:

```sql
-- Ensure only one email delivery row per brief (idempotency guard).
create unique index if not exists brief_email_deliveries_brief_id_uidx
  on public.brief_email_deliveries (brief_id);
```

### Task 4: Modify `libs/resend.js` — add `from` and `attachments` params, fix `@/config` import

```javascript
// 1. Fix import — change line 2 from:
import config from "@/config";
// To:
import config from "../config.js";
// (@/config won't resolve when imported transitively from server.mjs via plain Node)

// 2. Add `from` and `attachments` to the destructured params:
export const sendEmail = async ({ from, to, subject, text, html, replyTo, attachments }) => {
  const { data, error } = await resend.emails.send({
    from: from || config.resend.fromAdmin,
    to,
    subject,
    text,
    html,
    ...(replyTo && { replyTo }),
    ...(attachments && { attachments }),
  });
  // ... rest unchanged
};
```

### Task 5: Create `libs/email/briefEmail.mjs`

This file contains three things:
1. The marked custom renderer configured for email-safe HTML
2. The email HTML template wrapper
3. The `sendBriefEmail()` function that orchestrates everything

```javascript
// Pseudocode — key structure

import { Marked } from "marked";          // Marked class, NOT the global `marked` singleton
import juice from "juice";
import config from "../../config.js";      // relative path — node server.mjs has no @/ alias
import supabase from "../supabase/admin.mjs";
import { sendEmail } from "../resend.js";

const DASHBOARD_URL = `https://${config.domainName}/dashboard`;

// ── Scoped Marked instance with email renderer ───────────────────────
// Use `new Marked()` — NOT `marked.use()` — so the email renderer doesn't
// pollute the global marked instance if any other module imports marked.
const emailMarked = new Marked();
emailMarked.use({ renderer: {
  // Override all token types with inline styles. Use the complete renderer
  // from the research doc (tmp/research/2026-04-09-marked-email-safe-html.md
  // lines 181-275). Key methods: heading, paragraph, link, strong, em,
  // codespan, code, blockquote, list, listitem, table, hr, image, br, del.
  //
  // Font stack: Arial, Helvetica, sans-serif
  // Text color: #333333
  // Link color: #1a73e8
  // Use longhand CSS properties (margin-top not margin shorthand)
  //
  // NOTE: Verify the `list` renderer against the installed marked version.
  // In some versions, `items` are pre-rendered HTML strings — calling
  // `this.listitem(item)` on them double-renders. Use `items.join('')`
  // if items are already rendered.
} });

// ── Email template ────────────────────────────────────────────────────
function buildEmailHtml(bodyHtml, { episodeTitle, podcastName }) {
  // Wrap in 600px table layout:
  // 1. Header row: "View in your dashboard →" link to DASHBOARD_URL
  // 2. Title row: episode title + podcast name
  // 3. Body row: the rendered brief HTML
  // 4. Footer row: "You received this because..." + unsubscribe hint
  //
  // Run through juice() with applyWidthAttributes: true
  // Return the final inlined HTML string
}

// ── Send function ─────────────────────────────────────────────────────
export async function sendBriefEmail({ briefId, profileId, outputMarkdown, episodeTitle, podcastName }) {
  // 1. Look up profile email — destructure error to catch transient DB failures
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", profileId)
    .single();
  if (profileError) throw new Error(`Profile lookup failed: ${profileError.message}`);
  if (!profile?.email) return; // no email on file, skip silently

  // 2. Idempotent insert — unique index on brief_id means duplicate inserts fail.
  //    Check error.code to distinguish "already queued" (23505) from real failures.
  const { data: delivery, error: insertError } = await supabase
    .from("brief_email_deliveries")
    .insert({ brief_id: briefId, profile_id: profileId, status: "queued" })
    .select("id")
    .single();
  if (insertError) {
    if (insertError.code === "23505") return; // unique violation — already sent/queued
    throw new Error(`Email delivery insert failed: ${insertError.message}`);
  }
  if (!delivery?.id) return;

  // 3. Render — using scoped emailMarked instance, not the global
  const briefHtml = emailMarked.parse(outputMarkdown);
  const emailHtml = buildEmailHtml(briefHtml, { episodeTitle, podcastName });
  const plainText = outputMarkdown; // fallback for text-only clients

  // 4. Send via shared sendEmail helper — pass fromNoReply for automated notification
  const subject = episodeTitle
    ? `Your brief is ready: ${episodeTitle}`
    : "Your brief is ready";

  const filename = episodeTitle
    ? `${episodeTitle.replace(/[^a-zA-Z0-9-_ ]/g, "")}.md`
    : "brief.md";

  try {
    const data = await sendEmail({
      from: config.resend.fromNoReply,
      to: profile.email,
      subject,
      html: emailHtml,
      text: plainText,
      attachments: [{ filename, content: Buffer.from(outputMarkdown) }],
    });

    await supabase
      .from("brief_email_deliveries")
      .update({ status: "sent", provider_message_id: data.id, sent_at: new Date().toISOString() })
      .eq("id", delivery.id)
      .catch(() => {});
  } catch (err) {
    await supabase
      .from("brief_email_deliveries")
      .update({ status: "failed", error: err.message, failed_at: new Date().toISOString() })
      .eq("id", delivery.id)
      .catch(() => {});
    throw err; // re-throw so the outer .catch() in server.mjs logs it
  }
}
```

### Task 6: Modify `server.mjs` — call sendBriefEmail after success

At the success path (after `completeBrief` at line 203, before the degradation alert check at line 205):

```javascript
import { sendBriefEmail } from "./libs/email/briefEmail.mjs";

// Inside runPipeline(), after completeBrief succeeds:
// Awaited but non-blocking — errors caught, don't crash pipeline
if (finalBriefMd) {
  await sendBriefEmail({
    briefId,
    profileId,
    outputMarkdown: finalBriefMd,
    episodeTitle,
    podcastName,
  }).catch((err) => logError(`[email] Failed to send brief email for ${briefId}:`, err.message));
}
```

Note: `episodeTitle` and `podcastName` are already available in `runPipeline()` scope — they come from the `transcribe()` call at line 166.

### Task 7: Update `README.md` — document email notification

Add to the pipeline section documenting that brief completion triggers an email notification. Include a future improvement note:

> Email is currently awaited inline in `runPipeline()` (errors caught, non-blocking). In the future, true fire-and-forget with a separate email worker would be better and ideal if this actually gets any customers.

## Validation Loop

```bash
# After implementation, run:
node -e "import('./libs/email/briefEmail.mjs').then(m => console.log('import OK'))"  # verify module loads

# Full lint check:
npx eslint libs/email/briefEmail.mjs server.mjs
```

## Anti-Patterns to Avoid

- Don't create a separate Resend client — extend the existing `sendEmail()` in `libs/resend.js` with an optional `attachments` param.
- Don't make the email sending blocking — always `.catch()` errors so the pipeline completes even if email fails.
- Don't use `<style>` blocks in the email template — Gmail strips them. All styles inline.
- Don't use CSS shorthand (`margin: X Y`) — use longhand (`margin-top`, `margin-bottom`).
- Don't use `@/config` import alias in `.mjs` files — `node server.mjs` has no Next.js module resolution. Use relative paths.

## Deprecated Code

None — this is purely additive.

## Confidence 

8/10