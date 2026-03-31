// Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"
// Episode URL (?i=): transcribes exact episode. Show URL: transcribes latest episode.

import { DeepgramClient } from "@deepgram/sdk";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { v5 as uuidv5 } from "uuid";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";

// ── Setup ─────────────────────────────────────────────────────────

const appleUrl = process.argv[2];

if (!appleUrl) {
  console.error('Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"');
  process.exit(1);
}

if (!appleUrl.startsWith("https://podcasts.apple.com")) {
  console.error("[422] Invalid Apple Podcast show or episode link.");
  process.exit(1);
}

const missingEnv = ["DEEPGRAM_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]
  .filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`Missing env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const supabase = createSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

// ── Episode resolution ────────────────────────────────────────────

async function resolveFromEpisodeUrl(collectionId, trackId) {
  console.log(`Looking up episode (trackId: ${trackId})...`);
  const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=200`);
  const { results } = await res.json();
  const episode = results?.find((r) => String(r.trackId) === trackId);

  if (!episode) {
    console.error("[422] Episode not found in iTunes. The link may be stale or region-locked.");
    process.exit(1);
  }

  return {
    audioUrl: episode.episodeUrl,
    title: episode.trackName ?? "Untitled",
    date: episode.releaseDate?.split("T")[0] ?? "unknown-date",
    durationSeconds: Math.round((episode.trackTimeMillis ?? 0) / 1000),
    podcastName: episode.collectionName ?? "Unknown Podcast",
    episodeId: uuidv5(trackId, uuidv5.URL),
    rssUrl: null,
  };
}

async function resolveFromShowUrl(collectionId) {
  console.log(`Fetching latest episode from RSS...`);
  const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcast`);
  const { results } = await res.json();
  const rssUrl = results?.[0]?.feedUrl;

  if (!rssUrl) {
    console.error("[422] Could not resolve RSS feed. The podcast may not be on Apple Podcasts.");
    process.exit(1);
  }

  let feed;
  try {
    feed = await new Parser().parseURL(rssUrl);
  } catch (err) {
    console.error(`[422] Failed to parse RSS feed: ${err.message}`);
    process.exit(1);
  }

  const item = feed.items?.[0];
  if (!item) {
    console.error("[422] RSS feed has no episodes.");
    process.exit(1);
  }

  return {
    audioUrl: item.enclosure?.url,
    title: item.title ?? "Untitled",
    date: item.isoDate?.split("T")[0] ?? "unknown-date",
    durationSeconds: 0,
    podcastName: feed.title ?? "Unknown Podcast",
    episodeId: uuidv5(item.guid || item.enclosure?.url, uuidv5.URL),
    rssUrl,
  };
}

async function resolveEpisode(url) {
  const collectionId = url.match(/id(\d+)/)?.[1];
  if (!collectionId) {
    console.error("[422] Invalid Apple Podcast show or episode link.");
    process.exit(1);
  }

  const trackId = url.match(/[?&]i=(\d+)/)?.[1];
  return trackId
    ? resolveFromEpisodeUrl(collectionId, trackId)
    : resolveFromShowUrl(collectionId);
}

// ── Transcription ─────────────────────────────────────────────────

async function transcribe(audioUrl) {
  console.log("Transcribing via Deepgram (this may take a few minutes)...");
  try {
    return await deepgram.listen.v1.media.transcribeUrl({
      url: audioUrl,
      model: "nova-2",
      smart_format: true,
      diarize: true,
      utterances: true,
    });
  } catch (err) {
    console.error("Deepgram error:", err.message ?? err);
    process.exit(1);
  }
}

function buildSpeakerTurns(words) {
  const turns = [];
  let speaker = null, start = null, currentWords = [];

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

// ── Helpers ───────────────────────────────────────────────────────

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function saveMarkdown(episodeId, content) {
  const dir = path.join(process.cwd(), "briefs");
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${episodeId}-transcript.md`);
  fs.writeFileSync(filepath, content, "utf8");
  console.log(`Written: ${filepath}`);
}

// ── Main ──────────────────────────────────────────────────────────

const episode = await resolveEpisode(appleUrl);

if (!episode.audioUrl) {
  console.error("[422] No audio URL found for this episode.");
  process.exit(1);
}

console.log(`"${episode.title}" (${episode.date})`);

// Check cache
const { data: cached, error: cacheError } = await supabase
  .from("transcripts")
  .select("transcript_md")
  .eq("id", episode.episodeId)
  .single();

if (cacheError && cacheError.code !== "PGRST116") { // PGRST116 = no rows found (expected cache miss)
  console.error("Supabase error:", cacheError.message);
  process.exit(1);
}

if (cached) {
  console.log("Cache hit — using stored transcript.");
  saveMarkdown(episode.episodeId, cached.transcript_md);
  process.exit(0);
}

// Transcribe
const transcript = await transcribe(episode.audioUrl);
const words = transcript.results.channels[0].alternatives[0].words;
const durationSeconds = episode.durationSeconds || Math.round(transcript.metadata?.duration ?? 0);

// Build markdown
const turns = buildSpeakerTurns(words);
const body = turns.map((t) => `**[${formatTime(t.start)}] Speaker ${t.speaker}:** ${t.text}`).join("\n\n");
const md = `# ${episode.title}

**Podcast:** ${episode.podcastName}
**Date:** ${episode.date}
**Duration:** ${formatTime(durationSeconds)}

---

## Transcript

${body}
`;

// Store in Supabase
const { error: insertError } = await supabase.from("transcripts").insert({
  id: episode.episodeId,
  apple_url: appleUrl,
  rss_url: episode.rssUrl,
  episode_guid: episode.episodeId,
  episode_title: episode.title,
  episode_date: episode.date,
  audio_url: episode.audioUrl,
  duration_seconds: durationSeconds,
  transcript_md: md,
});

if (insertError) {
  console.error("Supabase insert error (file still written):", insertError.message);
}

saveMarkdown(episode.episodeId, md);
