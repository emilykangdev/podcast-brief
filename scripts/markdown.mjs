// Shared markdown utilities for parsing extract_wisdom brief output.
// Pure functions — no I/O, no side effects.

/**
 * Extracts a named section from an extract_wisdom markdown brief.
 * Matches headings of the form "## SECTION NAME" (1–3 hashes, case-insensitive).
 *
 * @param {string} md - Full markdown string
 * @param {string} sectionName - Section name to find (e.g. "REFERENCES")
 * @returns {{ headingLine: string, headingStart: number, content: string, contentEnd: number } | null}
 */
export function extractSection(md, sectionName) {
  const headingPattern = new RegExp(`^#{1,3}\\s+${sectionName.replace(/[-]/g, "[-]")}\\s*$`, "im");
  const headingMatch = headingPattern.exec(md);
  if (!headingMatch) return null;

  const afterHeadingStart = headingMatch.index + headingMatch[0].length;
  const afterHeading = md.slice(afterHeadingStart);
  const nextHeadingMatch = /^#{1,3}\s+/m.exec(afterHeading);
  const contentEnd = nextHeadingMatch ? afterHeadingStart + nextHeadingMatch.index : md.length;

  return {
    headingLine: headingMatch[0].trim(),
    headingStart: headingMatch.index,
    content: md.slice(afterHeadingStart, contentEnd),
    contentEnd,
  };
}
