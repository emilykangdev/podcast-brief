# Open Questions — PR #22 (add-test-infrastructure)

## Minor / sub-P3 (no action needed unless you want it)

- **CodeRabbit nitpick (Trivial/Quick-win)** — `.github/workflows/ci.yml` jobs (`lint-and-unit`, `integration`, `e2e`) have no `timeout-minutes`. If `supabase start` hangs or the e2e `webServer` never becomes ready, the job runs to GitHub Actions' 6-hour default cap instead of failing fast. Cheap to add (e.g. `timeout-minutes: 15`) but not fixed in this pass to keep the diff scoped to the threaded review findings.
- **CodeRabbit nitpick (Trivial/Quick-win, zizmor SAST)** — `.github/workflows/ci.yml` doesn't set workflow/job-level `permissions:` (defaults to broad `GITHUB_TOKEN` scope) and its three `actions/checkout@v4` steps don't set `persist-credentials: false`. Suggested hardening: top-level `permissions: contents: read` + `persist-credentials: false` on each checkout. Good practice, not a functional bug — deferred to keep this pass scoped.

## Decisions

(none)
