# CLAUDE.md

## Ground Truth

**`README.md` in the project root is the architectural ground truth for this codebase.** When working on server logic, pipeline code, infrastructure, or architecture, always read `README.md` first. It documents the brief lifecycle, pipeline steps, infrastructure, env vars, and key constraints.

**When the user agrees to merge a new feature**, update `README.md` to reflect any architectural changes (new status values, new services, new env vars, changed pipeline steps, etc.) before or as part of the merge commit.

## Plans

Complete implementation plans live in `tmp/done-plans/`. When working on a new plan, put it in `tmp/ready-plans`. Read the relevant plan before modifying pipeline or server code — they document design decisions and edge cases that aren't obvious from the code alone.

## Conventions

- **URL env vars:** Always use `cleanUrl("VAR_NAME")` from `libs/url.js` when building fetch URLs. Never use raw `process.env.SOME_URL` in a template literal.
- **Client API calls:** Use `apiClient` from `libs/api.js` for all frontend fetch calls. Never use raw `fetch()` in client components — `apiClient` provides automatic 401 redirect, toast errors, and centralized response handling.
- **Brief status lifecycle:** `queued → generating → complete`. A brief must always reach `complete`. Failed briefs get `error_log` populated.
- **Single worker constraint:** Browserbase free tier allows 1 concurrent session. Jobs are processed one at a time via Supabase polling, not an in-memory queue.
