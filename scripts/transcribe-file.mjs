// Usage: node --env-file=.env.local scripts/transcribe-file.mjs <path-to-media-file> [--out <output.md>]
// Sends a local audio/video file (mp4, mp3, wav, etc.) to Deepgram and writes a markdown transcript.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeepgramClient } from "@deepgram/sdk";

const DEEPGRAM_OPTS = { model: "nova-2", smart_format: true, diarize: true, utterances: true };
const DEEPGRAM_REQ_OPTS = { timeoutInSeconds: 600 };

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function buildSpeakerTurns(words) {
  const turns = [];
  let speaker = null;
  let start = null;
  let currentWords = [];

  for (const word of words) {
    if (word.speaker !== speaker) {
      if (currentWords.length > 0) turns.push({ speaker, start, text: currentWords.join(" ") });
      speaker = word.speaker;
      start = word.start;
      currentWords = [];
    }
    currentWords.push(word.punctuated_word ?? word.word);
  }
  if (currentWords.length > 0) turns.push({ speaker, start, text: currentWords.join(" ") });
  return turns;
}

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      args.out = argv[++i];
    } else if (!args.input) {
      args.input = a;
    }
  }
  return args;
}

async function main() {
  const { input, out } = parseArgs(process.argv.slice(2));

  if (!input) {
    console.error(
      "Usage: node --env-file=.env.local scripts/transcribe-file.mjs <path-to-media-file> [--out <output.md>]"
    );
    process.exit(1);
  }
  if (!process.env.DEEPGRAM_API_KEY) {
    console.error("Missing DEEPGRAM_API_KEY in env.");
    process.exit(1);
  }

  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(inputPath);
  console.error(`Input: ${inputPath} (${(stat.size / 1_000_000).toFixed(1)} MB)`);

  const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

  console.error("Uploading to Deepgram (this may take a few minutes for large files)...");
  const transcript = await deepgram.listen.v1.media.transcribeFile(
    fs.createReadStream(inputPath),
    DEEPGRAM_OPTS,
    DEEPGRAM_REQ_OPTS
  );

  const words = transcript.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!words?.length) {
    console.error("Deepgram returned no words. Full response:");
    console.error(JSON.stringify(transcript, null, 2));
    process.exit(1);
  }

  const duration = Math.round(transcript.metadata?.duration ?? 0);
  const turns = buildSpeakerTurns(words);
  const body = turns
    .map((t) => `**[${formatTime(t.start)}] Speaker ${t.speaker}:** ${t.text}`)
    .join("\n\n");

  const md = `# ${path.basename(inputPath)}

**Source:** ${inputPath}
**Duration:** ${formatTime(duration)}

---

## Transcript

${body}
`;

  const outPath = out
    ? path.resolve(out)
    : path.join(path.dirname(inputPath), `${path.parse(inputPath).name}-transcript.md`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, "utf8");
  console.error(`Written: ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
