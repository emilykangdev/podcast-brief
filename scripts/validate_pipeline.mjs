// scripts/validate_pipeline.mjs
// Pure validation functions for each pipeline step.
// Each returns { valid: boolean, reason: string | null }.
// No side effects, no I/O — safe to call from server.mjs between pipeline steps.

import { extractSection } from "./markdown.mjs";

const EXPECTED_SECTIONS = [
  "SUMMARY",
  "IDEAS",
  "INSIGHTS",
  "QUOTES",
  "HABITS",
  "FACTS",
  "REFERENCES",
  "ONE-SENTENCE TAKEAWAY",
  "RECOMMENDATIONS",
];

export function briefHasAllSections(md) {
  // Check that all expected extract_wisdom sections exist and have non-empty content.
  // A section is "empty" if there are no non-whitespace lines between it and the next heading.
  // Returns { valid: false, reason: "Missing sections: SUMMARY, IDEAS" } if any are missing/empty.
  // Returns { valid: true, reason: null } if all present.

  const missing = [];

  for (const section of EXPECTED_SECTIONS) {
    const result = extractSection(md, section);
    if (!result) {
      missing.push(section);
      continue;
    }
    const hasContent = result.content.split("\n").some((line) => line.trim().length > 0);
    if (!hasContent) missing.push(section);
  }

  if (missing.length > 0) {
    return { valid: false, reason: `Missing sections: ${missing.join(", ")}` };
  }

  return { valid: true, reason: null };
}

export function briefHasReferences(md) {
  // Check that a REFERENCES section exists with at least one bullet entry (line starting with - or *).
  // Returns { valid: false, reason: "No references found in REFERENCES section" } if missing/empty.
  // Returns { valid: true, reason: null } if present.

  const section = extractSection(md, "REFERENCES");
  if (!section) return { valid: false, reason: "No references found in REFERENCES section" };

  const hasBullet = section.content.split("\n").some((line) => /^\s*[-*]\s+\S/.test(line));
  if (!hasBullet) return { valid: false, reason: "No references found in REFERENCES section" };

  return { valid: true, reason: null };
}
