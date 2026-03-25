# Plan D: Brief Generation Script (generate-brief.mjs)

## Status: COMPLETE ✓

## What Was Built

`scripts/generate-brief.mjs` — a CLI script that takes a transcript file and generates a polished brief using Claude via OpenRouter, saving it to Supabase and a local file.

Plans A, B, and C (speaker map resolution, structured extraction, reference pre-resolution) were **collapsed entirely**. The final implementation is a simpler, more direct pipeline.

---

## Usage

```bash
node --env-file=.env.local scripts/generate-brief.mjs \
  <transcriptId> <transcript.md> "Episode Title" "Description" <profileId> [--force]

# NOTE: episodeDescription must always be passed — use "" if not available.
# Omitting it shifts profileId to the wrong positional arg.
```

**Exit codes:**
- `0` — success
- `1` — general error (missing args, missing file, API failure)
- `2` — brief already exists (complete or generating) — HTTP wrapper maps to 409

---

## Architecture

### Inputs
- `transcriptId` — used as the `input_url` key in the `briefs` table and output filename
- `transcriptPath` — path to a `.md` transcript file (produced by `transcribe.mjs`)
- `episodeTitle`, `episodeDescription` — passed to the LLM as context
- `profileId` — Supabase profile ID for the `briefs` row
- `--force` — deletes any existing row and regenerates (dev only)

### Pipeline

1. **409 check** — query `briefs` for existing `complete` or `generating` row for `(input_url, profile_id)`. If generating but stale (>5 min old), treat as crashed and delete it.
2. **Insert `generating` row** — written to Supabase before any API calls so crashes leave a visible row.
3. **Chunk transcript** — split at 400K chars (~100K tokens), breaking at speaker turn boundaries (`\n\n**[`). Most episodes fit in one chunk.
4. **Extract per chunk** — parallel Claude calls via OpenRouter using `prompts/extract_wisdom.md` as the system prompt. User content includes episode title + description + transcript segment.
5. **Merge chunks** — if >1 chunk, a second Claude call merges them into one coherent brief with deduplication rules per section.
6. **Write output** — brief written to `briefs/{transcriptId}-output-v{N}.md` (auto-versioned) and to stdout.
7. **Update Supabase row** — sets `output_markdown`, `status: "complete"`, `completed_at`.

### LLM Details
- **Model:** `anthropic/claude-opus-4-6` via OpenRouter
- **max_tokens:** 16,000 (extraction and merge calls)
- **System prompt:** loaded from `prompts/extract_wisdom.md` at runtime
- **Output format:** plain Markdown (not JSON)

### What Was Simplified Away vs Original Plan

| Original Plan D | Actual Implementation |
|---|---|
| `speakerMap` resolved from diarization | Not implemented — speakers remain "Speaker N" |
| Pre-resolved reference URLs injected into system prompt | Not implemented — Claude extracts references directly |
| `callOpenAI()` wrapper | Uses `callOpenRouter()` with OpenRouter API |
| `max_tokens: 4000` | `max_tokens: 16000` |
| Output to `brief-output.md` | Output to `briefs/{transcriptId}-output-v{N}.md` |
| No Supabase integration | Full Supabase lifecycle (generating → complete) |
| No 409 / idempotency logic | 409 check + stale row detection built in |

---

## Env Vars Required

- `OPENROUTER_API_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

# Review of it 

- I refined the prompt `extract_wisdom.md` so it produces actually good output! Asked it to also be more respectful, relay the cultural/historical analysis that speakers share, but don't use racial slurs, etc. And to keep the question it asks at the end respectful. Somehow. 