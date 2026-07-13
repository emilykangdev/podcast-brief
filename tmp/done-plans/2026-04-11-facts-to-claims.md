# Plan: Rename FACTS → CLAIMS in brief output

## Why
The brief's "FACTS" section presents unverified podcast content as established truth. Renaming to "CLAIMS" is more epistemically honest — the prompt already describes these as "verifiable claims about reality." This change aligns the section name with that framing.

## Files Being Changed

```
prompts/extract_wisdom.md    ← MODIFIED (section header + description + formatting instruction)
server.mjs                   ← MODIFIED (retry prompt string)
scripts/validate_pipeline.mjs ← MODIFIED (EXPECTED_SECTIONS array)
scripts/generate-brief.mjs   ← MODIFIED (merge prompt, 2 occurrences)
```

## Architecture Overview

The FACTS section name flows through 3 layers:
1. **Prompt** (`extract_wisdom.md`) — tells the LLM what to generate
2. **Generation** (`generate-brief.mjs`) — merge prompt for multi-chunk episodes references section names
3. **Validation** (`validate_pipeline.mjs` + `server.mjs`) — checks the LLM output has all required sections

All 3 layers must agree on the section name. This is a pure rename — no logic changes.

## Tasks

### Task 1: Update the prompt definition
**File:** `prompts/extract_wisdom.md`

**Line 19** — Rename section header and update description:
```
OLD: **FACTS** — 8–10 surprising or little-known facts about the world mentioned in the content. Should be verifiable claims about reality, not opinions. Exclude episode-specific details (addresses, anecdotes about specific people) — a fact should surprise someone who knows nothing about the guest or show.
NEW: **CLAIMS** — 8–10 surprising or little-known claims about the world mentioned in the content. These should be verifiable, not opinions. Exclude episode-specific details (addresses, anecdotes about specific people) — a claim should surprise someone who knows nothing about the guest or show.
```

**Line 33** — Update formatting instruction:
```
OLD: - Write each bullet in IDEAS, INSIGHTS, HABITS, FACTS, and RECOMMENDATIONS as a single sentence, 14–18 words.
NEW: - Write each bullet in IDEAS, INSIGHTS, HABITS, CLAIMS, and RECOMMENDATIONS as a single sentence, 14–18 words.
```

### Task 2: Update validation array
**File:** `scripts/validate_pipeline.mjs`

**Line 14** — Replace in EXPECTED_SECTIONS array:
```
OLD: "FACTS",
NEW: "CLAIMS",
```

### Task 3: Update retry prompt
**File:** `server.mjs`

**Line 36** — Replace in missingSections string:
```
OLD: (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS)
NEW: (SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, CLAIMS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS)
```

### Task 4: Update merge prompt
**File:** `scripts/generate-brief.mjs`

**Line 81** — Section order list:
```
OLD: SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS
NEW: SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, CLAIMS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS
```

**Line 89** — Dedup instruction:
```
OLD: - FACTS: Keep all unique facts. Drop exact duplicates only.
NEW: - CLAIMS: Keep all unique claims. Drop exact duplicates only.
```

## Files Intentionally NOT Changed
- `scripts/enrich-references.mjs:43` — "do NOT invent facts" is generic English, not the section name
- `tmp/` plan/brief files — historical records, not executed code
- No database migration — existing briefs keep their FACTS header; only new briefs get CLAIMS

## Confidence: 10/10
Pure string replacements across 4 files. No logic changes, no new dependencies, no edge cases.
