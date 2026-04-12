# Brief: Email notification on brief completion

## Why
Users should get an email when their brief finishes generating so they don't have to keep the dashboard open polling. One email per brief, exactly once, with the full brief content rendered as HTML plus a raw markdown attachment.

## Context
- `completeBrief()` in `server.mjs:74-88` is the single place where briefs finish. Called on success (~line 194) and on error (~line 216).
- `libs/resend.js` already exports `sendEmail({ to, subject, text, html, replyTo })`. Resend supports attachments natively.
- `brief_email_deliveries` table already exists with columns: `brief_id`, `profile_id`, `provider` (default 'resend'), `status` (queued/sent/delivered/failed), `provider_message_id`, error fields. Use this for idempotency.
- `profiles.email` has the user's email address. Join via `briefs.profile_id`.
- Briefs have `output_markdown`, `podcast_name`, `episode_title`.
- The pipeline guarantees `status='complete'` always. True failures (null `output_markdown`) only happen when transcription crashes or API keys are exhausted.
- Dashboard URL: `https://podcast-brief.vercel.app/dashboard` (briefs open in a modal, no individual brief URLs).
- `config.js:61-68` has `fromAdmin` and `fromNoReply` sender addresses.

## Decisions
- **Trigger in `runPipeline()` success path only** — send after `completeBrief()` at ~line 194, only when `outputMarkdown` is not null. Do not send on the error path (~line 216). — Keeps it simple; null output means nothing useful to send.
- **Idempotency via `brief_email_deliveries`** — before sending, check for existing row with this `brief_id`. Insert `queued` row before send, update to `sent` after. — Handles retries, server restarts, duplicate pipeline runs.
- **Markdown to HTML via `marked`** — lightweight, server-side, one-shot render. Wrap in email-safe HTML template with inline styles. — No need for heavier solutions like React Email for a single template.
- **Attach raw markdown as `.md` file** — Resend supports attachments. Attach `output_markdown` as `{episode_title}.md` (fallback to `brief.md`). — Users can open in any text editor; no clipboard API needed in email.
- **Dashboard link at top of email** — link to `https://podcast-brief.vercel.app/dashboard`. — Users who prefer the web UI can go straight there.
- **Subject line: `Your brief is ready: {episode_title}`** — fallback to `Your brief is ready` if episode_title is missing.
- **Use `fromNoReply` sender** — this is an automated notification, not a conversation.
- **Skip email on failure** — if `outputMarkdown` is null, don't send. These are rare (Deepgram crash, API key exhaustion) and there's nothing useful to show.

## Rejected Alternatives
- **Supabase Edge Function / DB trigger** — adds infrastructure complexity; the worker already has the data in hand right after `completeBrief()`.
- **`<pre>` block for markdown copy** — doubles email size, looks ugly. `.md` attachment is cleaner.
- **Link-based "copy" button** — would require a new API route or web page just to serve the copy action. Overkill.
- **React Email / JSX templates** — heavier setup for a single email template. `marked` + inline styles is sufficient.
- **Sending email on failed briefs** — nothing useful to send when `output_markdown` is null.

## Direction
After `completeBrief()` succeeds with non-null output in `runPipeline()`, look up the user's email from `profiles`, check `brief_email_deliveries` for idempotency, render `output_markdown` to HTML via `marked`, and send via Resend with the raw markdown attached as a `.md` file. The email has a dashboard link at the top, the rendered brief as the body, and the attachment for offline/copy use.
