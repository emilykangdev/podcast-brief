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
# 1. Transcribe — downloads audio and transcribes via Deepgram
node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"
# → briefs/<transcriptId>-transcript.md  (also saves to Supabase, prints transcriptId UUID)

# 2. Generate brief — runs extract_wisdom over the transcript
node --env-file=.env.local scripts/generate-brief.mjs <transcriptId> briefs/<transcriptId>-transcript.md <profileId>
# → briefs/<transcriptId>-output-v1.md

# 3. Enrich references — AI filters + Exa search, 3 candidate URLs per ref
node --env-file=.env.local scripts/enrich-references.mjs briefs/<transcriptId>-output-v1.md
# → briefs/<transcriptId>-references.json

# 4. Validate references — Browserbase checks each candidate, picks first valid URL
node --env-file=.env.local scripts/validate-references.mjs briefs/<transcriptId>-references.json
# → briefs/<transcriptId>-references.md

# 5. Merge — splices validated references back into the brief
node scripts/merge-references.mjs briefs/<transcriptId>-output-v1.md briefs/<transcriptId>-references.md
# → briefs/<transcriptId>-final-brief.md
```

- `transcriptId` — UUID printed by `transcribe.mjs` after a successful run
- `profileId` — Supabase user profile ID
- Step 1 requires: `DEEPGRAM_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`
- Steps 2–3 require: `OPENROUTER_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`
- Step 3 also requires: `EXA_API_KEY`
- Step 4 requires: `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`

## What are the Output Files? 

```
  briefs/a3f7b291-transcript.md      ← transcribe                                                                                  
  briefs/a3f7b291-output-v1.md       ← generate-brief                                                                              
  briefs/a3f7b291-references.json    ← enrich                                                                                      
  briefs/a3f7b291-references.md      ← validate                                                                                    
  briefs/a3f7b291-final-brief.md     ← merge                                                                                       
```                                                                                                                            
  Everything in briefs/, one UUID prefix per episode.

Note: `generate-brief.mjs` is the only one that does not overwrite its outputs when the same command is run. It attaches v1, v2, v3, and so on and so forth. This is helpful when you want to see previous briefs but also need to re-generate.

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

# Limitations 

Sites like ResearchGate, bioRxiv, and university repositories are notoriously aggressive about blocking automated/headless browsers. They use bot detection (CAPTCHAs, rate limiting, user-agent checks, etc.) specifically to prevent scraping, so when Browserbase hits them, they often return 403s or redirect to challenge pages.