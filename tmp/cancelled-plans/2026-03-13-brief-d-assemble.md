# Plan D: Polished Brief Assembly (fabric extract_wisdom style)

## Goal

Replace the simple markdown assembly in `scripts/generate-brief.mjs` (from Plans A–C) with a final Claude call using a `extract_wisdom`-inspired system prompt. Feed it the full chunked transcript text + resolved references, and let Claude produce a rich, polished brief in one shot.

**Branch:** `brief-d-assemble`
**Prerequisite:** Plans A, B, and C implemented and working.

## Why

- The current assembly step just formats structured JSON into markdown — Claude never sees the full picture for the final output
- Fabric's `extract_wisdom` prompt is designed exactly for this: pull surprising, insightful content from conversations
- Feeding both the transcript AND the pre-resolved references gives Claude richer material to work with
- Result: a brief that reads like something a human editor wrote, not a template fill-in

## What

Replace `assembleBrief()` with a `generateBrief()` function that makes a final Claude call:
- Input: full transcript text (or concatenated chunks if chunked) + resolved references with URLs
- Output: polished Markdown brief with all sections
- The final call uses a system prompt adapted from fabric's `extract_wisdom`

### Success Criteria

- [ ] Final brief is noticeably richer/more insightful than template-assembled output
- [ ] All sections present: SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS
- [ ] References section uses pre-resolved URLs from Plan C (not hallucinated)
- [ ] Speaker names are real (from speakerMap resolved in Plan A/B)
- [ ] Brief written to `brief-output.md`

---

## All Needed Context

### Fabric extract_wisdom System Prompt

Source: `https://raw.githubusercontent.com/danielmiessler/fabric/main/data/patterns/extract_wisdom/system.md`

Full prompt text (fetch at implementation time via `gh api`):

```
# IDENTITY and PURPOSE

You extract surprising, insightful, and interesting information from text content. You are interested
in insights related to the purpose and meaning of life, human flourishing, the role of technology in
the future of humanity, artificial intelligence and its affect on humans, memes, learning, reading,
books, continuous improvement, and similar topics.

Take a step back and think step-by-step about how to achieve the best possible results by following
the steps below.

# STEPS

- Extract a summary of the content in 25 words into a section called SUMMARY.
- Extract 20 to 50 of the most surprising, insightful, and/or interesting ideas into IDEAS.
- Extract 10 to 20 of the best insights into INSIGHTS (more refined, abstracted versions of IDEAS).
- Extract 15 to 30 of the most surprising, insightful quotes into QUOTES. Use exact quote text.
- Extract 15 to 30 practical personal habits mentioned or modeled into HABITS.
- Extract 15 to 30 surprising valid facts mentioned into FACTS.
- Extract all mentions of writing, art, tools, projects, sources of inspiration into REFERENCES.
- Extract the most potent takeaway into ONE-SENTENCE TAKEAWAY (15 words).
- Extract 15 to 30 of the most insightful recommendations into RECOMMENDATIONS.

# OUTPUT INSTRUCTIONS

- Only output Markdown.
- Write IDEAS, RECOMMENDATIONS, HABITS, FACTS, INSIGHTS bullets as exactly 16 words each.
- Extract at least 25 IDEAS, 10 INSIGHTS, 20 items for other sections.
- No warnings or notes — only output the requested sections.
- Use bulleted lists, not numbered lists.
- Do not repeat ideas, insights, quotes, habits, facts, or references.
- Do not start items with the same opening words.
```

### Adaptation for this script

We extend the fabric prompt with:
1. A section telling Claude the speaker identities (from speakerMap)
2. A pre-resolved references block — Claude must USE these URLs in the REFERENCES section rather than hallucinating them

### Files Being Changed

```
scripts/
└── generate-brief.mjs   ← MODIFIED (replace assembleBrief with generateBrief)
```

### Known Gotchas

```js
// CRITICAL: max_tokens for the final assembly call should be 4000.
// The fabric prompt requests many sections with many bullets — needs headroom.

// CRITICAL: Do NOT use jsonMode for this call — fabric output is plain Markdown, not JSON.

// CRITICAL: For chunked transcripts, pass the CONCATENATED full transcript text
// to generateBrief(), not just the first chunk. The chunks are already in memory
// as the array used during extraction — just join them.

// CRITICAL: The REFERENCES section in the fabric output must use the pre-resolved URLs.
// Explicitly instruct Claude: "Use ONLY the reference URLs provided below. Do not invent URLs."
```

---

## Implementation Blueprint

### Replace assembleBrief() with generateBrief()

```js
// ── step 4: polished brief assembly ──────────────────────────────────────────

const BRIEF_SYSTEM = (speakerMap, resolvedRefs) => `
# IDENTITY and PURPOSE

You extract surprising, insightful, and interesting information from podcast transcripts.
You are interested in insights related to the purpose and meaning of life, human flourishing,
the role of technology in the future of humanity, artificial intelligence and its affect on humans,
memes, learning, reading, books, continuous improvement, and similar topics.

Take a step back and think step-by-step about how to achieve the best possible results.

# SPEAKER IDENTITIES

${Object.entries(speakerMap).map(([k, v]) => `${k} = ${v}`).join("\n")}
Use real names (not "Speaker N") throughout.

# STEPS

- Extract a summary of the content in 25 words into a section called SUMMARY.
- Extract 20 to 50 of the most surprising, insightful, and/or interesting ideas into IDEAS.
- Extract 10 to 20 of the best insights into INSIGHTS (more refined, abstracted versions of IDEAS).
- Extract 15 to 30 of the most surprising, insightful quotes into QUOTES. Use exact quote text. Include speaker name.
- Extract 15 to 30 practical personal habits mentioned or modeled into HABITS.
- Extract 15 to 30 surprising valid facts mentioned into FACTS.
- For REFERENCES, use ONLY the pre-resolved list below. Do not invent or hallucinate URLs.
- Extract the most potent takeaway into ONE-SENTENCE TAKEAWAY (15 words).
- Extract 15 to 30 of the most insightful recommendations into RECOMMENDATIONS.

# PRE-RESOLVED REFERENCES

${resolvedRefs.length
  ? resolvedRefs.map((r) => r.url
      ? `- **${r.name}**: ${r.context} — ${r.url}`
      : `- **${r.name}**: ${r.context}`
    ).join("\n")
  : "No references resolved."}

# OUTPUT INSTRUCTIONS

- Only output Markdown.
- Write IDEAS, RECOMMENDATIONS, HABITS, FACTS, INSIGHTS bullets as exactly 16 words each.
- Use bulleted lists, not numbered lists.
- Do not repeat ideas, insights, quotes, habits, facts, or references.
- Do not start items with the same opening words.
- Do not add warnings, notes, or preamble — only the requested sections.

# INPUT

INPUT:
`;

async function generateBrief(fullTranscript, episodeTitle, speakerMap, resolvedRefs) {
  console.error("Step 4: Generating polished brief...");
  const system = BRIEF_SYSTEM(speakerMap, resolvedRefs);
  const userContent = `Episode title: ${episodeTitle}\n\nTranscript:\n${fullTranscript}`;
  return callOpenAI(system, userContent, { jsonMode: false, maxTokens: 4000 });
}
```

### Update Main Block

```js
// Keep full transcript text around for the final call:
const fullTranscript = readFileSync(transcriptPath, "utf-8"); // already read earlier

// After Plan C's resolveReferences():
console.error("Step 4: Generating polished brief...");
const brief = await generateBrief(fullTranscript, episodeTitle, extracted.speakerMap ?? {}, resolved);

process.stdout.write("\n" + brief);
writeFileSync("brief-output.md", brief, "utf-8");
console.error("✓ Brief written to brief-output.md");
```

Remove the old `assembleBrief()` function entirely.

### Tasks

```yaml
Task 1 — Add BRIEF_SYSTEM template:
  Add above generateBrief(). Takes speakerMap and resolvedRefs.
  Embeds speaker identities and pre-resolved reference URLs.

Task 2 — Add generateBrief() function:
  One Claude call, jsonMode: false, maxTokens: 4000.

Task 3 — Update main block:
  Replace assembleBrief() call with generateBrief().
  Pass fullTranscript (already in memory), episodeTitle, extracted.speakerMap, resolved refs.

Task 4 — Remove assembleBrief():
  Delete the old function — it is no longer used.
```

---

## Validation Loop

```bash
# 1. End-to-end run
node scripts/generate-brief.mjs scripts/sample-transcript.md "Sample Episode" "A conversation about resilience."
# Expected: all 4 steps logged, brief written to brief-output.md

# 2. Inspect output
cat brief-output.md
# Expected:
#   - Sections: SUMMARY, IDEAS, INSIGHTS, QUOTES, HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY, RECOMMENDATIONS
#   - Real speaker names (not "Speaker 0")
#   - REFERENCES section uses URLs from Plan C (not hallucinated)
#   - IDEAS/INSIGHTS bullets are exactly 16 words each
#   - No "[object Object]", no "undefined", no stray JSON
```

## Anti-Patterns to Avoid

- Do NOT use jsonMode for the assembly call — output is plain Markdown
- Do NOT let Claude hallucinate reference URLs — pass resolved refs explicitly in the system prompt
- Do NOT pass only chunk 0 transcript to generateBrief — pass the full transcript
- Do NOT keep assembleBrief() around — remove it completely
- Do NOT set maxTokens below 4000 for this call — the fabric output is verbose by design
