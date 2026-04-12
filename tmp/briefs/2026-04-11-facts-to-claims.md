# Brief: Rename FACTS section to CLAIMS in briefs

## Why
The brief output includes a "FACTS" section, but the content is extracted from podcast episodes — unverified source material. Labeling these as "facts" implies they're confirmed truths, which could reinforce misinformation. "CLAIMS" is more epistemically honest and already aligns with the prompt's own description ("verifiable claims about reality").

## Context
The FACTS section is one of 9 required sections in every generated brief: SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS.

Files that reference the section name:
- `prompts/extract_wisdom.md:19,33` — Section definition + formatting instruction
- `server.mjs:36` — Required sections validation string
- `scripts/validate_pipeline.mjs:14` — Section name in validation array
- `scripts/generate-brief.mjs:81,89` — Merge prompt section list + dedup instruction

Files intentionally left unchanged:
- `scripts/enrich-references.mjs:43` — "do NOT invent facts" is generic English, not the section name
- `tmp/` plan files — Historical docs, not executed code

## Decisions
- Rename `FACTS` → `CLAIMS` in all 4 source files listed above — straightforward find-and-replace
- Update the description in `extract_wisdom.md` to say "claims" instead of "facts" in the body text
- Leave `enrich-references.mjs` "do NOT invent facts" as-is — it's an LLM hallucination guard, not a section reference
- Leave old plan files in `tmp/` unchanged — they're historical records
- No migration needed for existing briefs in the database — old briefs keep their FACTS header, new briefs get CLAIMS

## Rejected Alternatives
- Accepting both FACTS and CLAIMS in validation — adds complexity for no benefit; old briefs won't be re-validated
- Renaming to something softer like "NOTABLE MENTIONS" — too vague, loses the epistemic framing the user wants

## Direction
Replace all references to the FACTS section name with CLAIMS across the 4 pipeline/prompt files. Update the description text in the prompt to use "claims" language. No database migration or backward-compat shim needed.
