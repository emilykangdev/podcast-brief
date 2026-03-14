// Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"
// Episode URL (?i=): transcribes exact episode.
// Show URL (no ?i=): transcribes latest episode.
// Must be run from project root.

import { createClient as createDeepgram } from "@deepgram/sdk";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { v5 as uuidv5 } from "uuid";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";

// ── Helpers ──────────────────────────────────────────────────────

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function formatDuration(raw, fallbackSeconds) {
  if (raw) {
    if (raw.includes(":")) {
      const parts = raw.split(":");
      while (parts.length < 3) parts.unshift("0");
      return parts.map((p) => String(p).padStart(2, "0")).join(":");
    }
    return formatTime(parseInt(raw, 10));
  }
  return formatTime(fallbackSeconds);
}

function writeMarkdownFile(title, date, content) {
  const outputDir = path.join(process.cwd(), "transcripts");
  fs.mkdirSync(outputDir, { recursive: true });
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "episode";
  const filepath = path.join(outputDir, `${slug}-${date}.md`);
  fs.writeFileSync(filepath, content, "utf8");
  console.log(`Written: ${filepath}`);
}

// ── 1. Validate args & env vars ──────────────────────────────────

const appleUrl = process.argv[2];

if (!appleUrl) {
  console.error(
    'Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"'
  );
  process.exit(1);
}

if (!appleUrl.startsWith("https://podcasts.apple.com")) {
  console.error("[422] Input must be an Apple Podcasts URL.");
  console.error(
    "Example: https://podcasts.apple.com/us/podcast/show/id1143709275?i=1000612345"
  );
  process.exit(1);
}

const podcastMatch = appleUrl.match(/id(\d+)/);
if (!podcastMatch) {
  console.error("[422] Could not extract iTunes ID from URL.");
  process.exit(1);
}
const collectionId = podcastMatch[1];
const episodeMatch = appleUrl.match(/[?&]i=(\d+)/);
const trackId = episodeMatch?.[1] ?? null; // null = show URL mode

const missingEnv = [
  "DEEPGRAM_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
].filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`Missing env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

// ── 2. Resolve episode metadata ──────────────────────────────────

let audioUrl, title, date, durationSeconds, podcastName, episodeId, rssUrl;

if (trackId) {
  // ── Mode A: Episode URL — look up exact episode by trackId ──────
  console.log(`Episode URL detected. Looking up episode (trackId: ${trackId})...`);

  const res = await fetch(
    `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=200`
  );
  const json = await res.json();
  const episode = json.results?.find((r) => r.trackId === parseInt(trackId));

  if (!episode) {
    console.error(
      "[422] Episode not found in iTunes. The link may be stale or region-locked."
    );
    process.exit(1);
  }

  audioUrl = episode.episodeUrl;
  title = episode.trackName ?? "Untitled";
  date = episode.releaseDate?.split("T")[0] ?? "unknown-date";
  durationSeconds = Math.round((episode.trackTimeMillis ?? 0) / 1000);
  podcastName = episode.collectionName ?? "Unknown Podcast";
  rssUrl = null; // not needed in Mode A
  episodeId = uuidv5(trackId, uuidv5.URL);

  console.log(`Episode: "${title}" (${date})`);
} else {
  // ── Mode B: Show URL — get RSS feed, use latest episode ─────────
  console.log(`Show URL detected. Fetching latest episode...`);

  const res = await fetch(
    `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcast`
  );
  const json = await res.json();
  rssUrl = json.results?.[0]?.feedUrl;

  if (!rssUrl) {
    console.error(
      "[422] Could not resolve RSS feed. The podcast may not be on Apple Podcasts."
    );
    process.exit(1);
  }

  let feed;
  try {
    feed = await new Parser().parseURL(rssUrl);
  } catch (err) {
    console.error(`[422] Failed to parse RSS feed: ${err.message}`);
    process.exit(1);
  }

  const item = feed.items[0];
  audioUrl = item.enclosure?.url;
  title = item.title ?? "Untitled";
  date = item.isoDate?.split("T")[0] ?? "unknown-date";
  durationSeconds = 0; // filled from Deepgram metadata below
  podcastName = feed.title ?? "Unknown Podcast";
  episodeId = uuidv5(item.guid || audioUrl, uuidv5.URL);

  console.log(`Latest episode: "${title}" (${date})`);
}

if (!audioUrl) {
  console.error("[422] No audio URL found for this episode.");
  process.exit(1);
}

console.log(`Episode ID: ${episodeId}`);

// ── 3. Check Supabase cache ──────────────────────────────────────

const supabase = createSupabase(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const { data: cached, error: cacheError } = await supabase
  .from("transcripts")
  .select("transcript_md")
  .eq("id", episodeId)
  .single();

if (cacheError && cacheError.code !== "PGRST116") {
  console.error("Supabase error:", cacheError.message);
  process.exit(1);
}

if (cached) {
  console.log("Cache hit — using stored transcript.");
  writeMarkdownFile(title, date, cached.transcript_md);
  process.exit(0);
}

// ── 4. Transcribe via Deepgram ───────────────────────────────────

console.log("Transcribing via Deepgram (this may take a few minutes)...");
const deepgram = createDeepgram(process.env.DEEPGRAM_API_KEY);

const { result, error: dgError } = await deepgram.listen.prerecorded.transcribeUrl(
  { url: audioUrl },
  { model: "nova-2", smart_format: true, diarize: true, utterances: true }
);

if (dgError) {
  console.error("Deepgram error:", dgError);
  process.exit(1);
}

const words = result.results.channels[0].alternatives[0].words;
const dgDuration = Math.round(result.metadata?.duration ?? 0);
if (!durationSeconds) durationSeconds = dgDuration;

// ── 5. Group words into speaker turns ────────────────────────────

const turns = [];
let currentSpeaker = null,
  currentStart = null,
  currentWords = [];

for (const word of words) {
  if (word.speaker !== currentSpeaker) {
    if (currentWords.length > 0) {
      turns.push({
        speaker: currentSpeaker,
        start: currentStart,
        text: currentWords.join(" "),
      });
    }
    currentSpeaker = word.speaker;
    currentStart = word.start;
    currentWords = [];
  }
  currentWords.push(word.punctuated_word ?? word.word);
}
if (currentWords.length > 0) {
  turns.push({ speaker: currentSpeaker, start: currentStart, text: currentWords.join(" ") });
}

// ── 6. Build Markdown ────────────────────────────────────────────

const transcriptBody = turns
  .map((t) => `**[${formatTime(t.start)}] Speaker ${t.speaker}:** ${t.text}`)
  .join("\n\n");

const md = `# ${title}

**Podcast:** ${podcastName}
**Date:** ${date}
**Duration:** ${formatTime(durationSeconds)}

---

## Transcript

${transcriptBody}
`;

// ── 7. Store in Supabase ─────────────────────────────────────────

const { error: insertError } = await supabase.from("transcripts").insert({
  id: episodeId,
  apple_url: appleUrl,
  rss_url: rssUrl,
  episode_guid: trackId ?? audioUrl,
  episode_title: title,
  episode_date: date,
  audio_url: audioUrl,
  duration_seconds: durationSeconds,
  transcript_md: md,
});

if (insertError) {
  console.error("Supabase insert error (file still written):", insertError.message);
}

// ── 8. Write MD file ─────────────────────────────────────────────

writeMarkdownFile(title, date, md);
