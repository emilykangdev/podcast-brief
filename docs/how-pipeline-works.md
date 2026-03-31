# How the Reference Pipeline Works

## Current (implemented)

```
enrich-references.mjs
  IN:  briefs/abc123-output.md
  OUT: briefs/abc123-references.json    ← [{ name, candidates: [url, url, url] }]

validate-references.mjs
  IN:  briefs/abc123-references.json
  OUT: briefs/abc123-references.md      ← "- [Name](url)" per ref (best validated URL)

merge-references.mjs                    ← untouched
  IN:  briefs/abc123-output.md
       briefs/abc123-references.md
  OUT: briefs/abc123-final-brief.md
```

Enrich outputs JSON only. Validate reads the JSON, checks each candidate URL via
Browserbase (one session per run), and produces the `.md` that merge already expects.

## How to Run

```bash
# 1. Generate the brief (produces briefs/abc123-output.md)
node --env-file=.env.local scripts/generate-brief.mjs <apple-podcasts-url>

# 2. Enrich references — AI filters + Exa search, 3 candidate URLs per ref
node --env-file=.env.local scripts/enrich-references.mjs briefs/abc123-output.md
# → briefs/abc123-references.json

# 3. Validate references — Browserbase checks each candidate, picks first valid URL
node --env-file=.env.local scripts/validate-references.mjs briefs/abc123-references.json
# → briefs/abc123-references.md

# 4. Merge — splices validated references back into the brief
node scripts/merge-references.mjs briefs/abc123-output.md briefs/abc123-references.md
# → briefs/abc123-final-brief.md
```

Replace `abc123` with the actual podcast ID (derived from the episode URL).
Steps 2–4 require `EXA_API_KEY`, `OPENROUTER_API_KEY`, `BROWSERBASE_API_KEY`, and `BROWSERBASE_PROJECT_ID` in `.env.local`.

## Design Principle: Scripts vs Orchestrator

Each script does one thing. An orchestrator (not implemented yet) handles pipeline
logic between steps — individual scripts should not defensively paper over their own
empty output to satisfy the next step. Empty or missing output is meaningful signal.

Examples of orchestrator responsibilities:
- Enrich produced no references → skip validate + merge, re-trigger make-brief
- Validate produced no valid URLs → flag it, don't merge garbage into the brief
- Make-brief failed → retry once before alerting

If enrich exits with no references, writing an empty `[]` would obscure that signal.
The orchestrator checks output existence before invoking the next script.
