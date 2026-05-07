import { readFile } from "node:fs/promises";
import path from "node:path";

// Example briefs live in content/examples/ (checked into git).
// The /briefs/ directory is gitignored — it's the worker's runtime output dir.
const examplesDir = path.join(process.cwd(), "content", "examples");

export const exampleBriefs = [
  {
    slug: "stacey-warshaw-ecommerce",
    title: "Stacey Warshaw — Head of Ecommerce & Digital Marketing at LoveShackFancy",
    subtitle: "Brand–performance balance, omnichannel reality, and AI adoption",
    podcastName: "The Marketing Playbook",
    summary:
      "Stacey Warshaw on the path from PR to leading digital marketing and ecommerce at LoveShackFancy — why brand-led performance is the only kind that lasts, how to read collaborations as their own funnel, and where AI actually moves the needle.",
    readingLabel: "6 min read",
    file: "stacey-warshaw-ecommerce.md",
  },
  {
    slug: "kat-cole-ag1",
    title: "Kat Cole — AG1 CEO, Cinnabon President, Hooters Girl",
    subtitle: "Brand strategy, quality-driven growth, and a leader's playbook",
    podcastName: "Wild Business Growth",
    summary:
      "Kat Cole on her journey from Hooters waitress to AG1 CEO — why Cinnabon's ovens stay up front, how AG1 grew without paid sponsorships, and the operating principles she's used to lead through every stage.",
    readingLabel: "6 min read",
    file: "kat-cole-ag1.md",
  },
  {
    slug: "ts-go-effect-lsp",
    title: "TypeScript Go with Effect LSP",
    subtitle: "Setup, diagnostics, and the 7× performance boost",
    summary:
      "Mattia walks through the Effect LSP integrated with TypeScript Go — setup, diagnostics, refactoring, and how compiler-level feedback steers both humans and LLMs toward better Effect patterns.",
    durationLabel: "≈ 50 min episode",
    readingLabel: "5 min read",
    file: "ts-go-effect-lsp.md",
  },
];

export function getExampleBrief(slug) {
  return exampleBriefs.find((b) => b.slug === slug) ?? null;
}

export async function loadExampleBriefMarkdown(slug) {
  const brief = getExampleBrief(slug);
  if (!brief) return null;
  return readFile(path.join(examplesDir, brief.file), "utf8");
}
