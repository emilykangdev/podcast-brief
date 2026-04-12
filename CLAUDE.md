# CLAUDE.md

## Ground Truth

**`README.md` in the project root is the architectural ground truth for this codebase.** When working on server logic, pipeline code, infrastructure, or architecture, always read `README.md` first. It documents the brief lifecycle, pipeline steps, infrastructure, env vars, and key constraints.

**When the user agrees to merge a new feature**, update `README.md` to reflect any architectural changes (new status values, new services, new env vars, changed pipeline steps, etc.) before or as part of the merge commit.

## Plans

Complete implementation plans live in `tmp/done-plans/`. When working on a new plan, put it in `tmp/ready-plans`. Read the relevant plan before modifying pipeline or server code — they document design decisions and edge cases that aren't obvious from the code alone.

## Conventions

- **URL env vars:** Always use `cleanUrl("VAR_NAME")` from `libs/url.mjs` when building fetch URLs. Never use raw `process.env.SOME_URL` in a template literal.
- **Client API calls:** Use `apiClient` from `libs/api.js` for all frontend fetch calls. Never use raw `fetch()` in client components — `apiClient` provides automatic 401 redirect, toast errors, and centralized response handling.
- **Brief status lifecycle:** `queued → generating → complete`. A brief must always reach `complete`. Failed briefs get `error_log` populated.
- **Single worker constraint:** Browserbase free tier allows 1 concurrent session. Jobs are processed one at a time via Supabase polling, not an in-memory queue.
- **`.mjs` vs `.js` — two module worlds, never cross them:**
  - `.js` files (Next.js code): Use ESM syntax (`import`/`export`) but rely on Next.js to transpile them. They run on Vercel.
  - `.mjs` files (worker/script code): Real ESM, run with plain `node server.mjs` on Railway (Node 18). No transpiler.
  - **NEVER import a `.js` file from a `.mjs` file.** Node 18 treats `.js` as CommonJS (no `"type": "module"` in package.json), so ESM syntax in `.js` files causes a crash under plain Node. If worker code needs something from a `.js` file, either duplicate the value inline or create a shared `.mjs` module.
  - **NEVER import a `.mjs` file from a `.js` file.** Next.js can handle it but it creates a confusing dependency direction.
  - Shared code used by both worlds must be in `.mjs` files (e.g., `libs/supabase/admin.mjs`, `libs/url.mjs`).
