// Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"
// Episode URL (?i=): transcribes exact episode. Show URL: transcribes latest episode.

import { DeepgramClient } from "@deepgram/sdk";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { v5 as uuidv5 } from "uuid";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ── Episode resolution ────────────────────────────────────────────

async function resolveFromEpisodeUrl(collectionId, trackId) {
  console.error(`Looking up episode (trackId: ${trackId})...`);
  const res = await fetch(
    `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=200`
  );
  const { results } = await res.json();
  const episode = results?.find((r) => String(r.trackId) === trackId);

  if (!episode) {
    throw new Error("[422] Episode not found in iTunes. The link may be stale or region-locked.");
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
  console.error(`Fetching latest episode from RSS...`);
  const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcast`);
  const { results } = await res.json();
  const rssUrl = results?.[0]?.feedUrl;

  if (!rssUrl) {
    throw new Error("[422] Could not resolve RSS feed. The podcast may not be on Apple Podcasts.");
  }

  let feed;
  try {
    feed = await new Parser().parseURL(rssUrl);
  } catch (err) {
    throw new Error(`[422] Failed to parse RSS feed: ${err.message}`);
  }

  const item = feed.items?.[0];
  if (!item) {
    throw new Error("[422] RSS feed has no episodes.");
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
    throw new Error("[422] Invalid Apple Podcast show or episode link.");
  }

  const trackId = url.match(/[?&]i=(\d+)/)?.[1];
  return trackId ? resolveFromEpisodeUrl(collectionId, trackId) : resolveFromShowUrl(collectionId);
}

// ── Transcription ─────────────────────────────────────────────────

async function transcribe(deepgram, audioUrl) {
  console.error("Transcribing via Deepgram (this may take a few minutes)...");
  try {
    return await deepgram.listen.v1.media.transcribeUrl({
      url: audioUrl,
      model: "nova-2",
      smart_format: true,
      diarize: true,
      utterances: true,
    });
  } catch (err) {
    throw new Error(`Deepgram error: ${err.message ?? err}`);
  }
}

function buildSpeakerTurns(words) {
  const turns = [];
  let speaker = null,
    start = null,
    currentWords = [];

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

function saveMarkdown(episodeId, content, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filepath = path.join(outputDir, `${episodeId}-transcript.md`);
  fs.writeFileSync(filepath, content, "utf8");
  console.error(`Written: ${filepath}`);
  return filepath;
}

// ── Main export ───────────────────────────────────────────────────

export async function run(appleUrl, { outputDir } = {}) {
  if (!outputDir) outputDir = path.join(process.cwd(), "briefs");

  if (!appleUrl || !appleUrl.startsWith("https://podcasts.apple.com")) {
    throw new Error("[422] Invalid Apple Podcast show or episode link.");
  }

  const missingEnv = ["DEEPGRAM_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missingEnv.length > 0) {
    throw new Error(`Missing env vars: ${missingEnv.join(", ")}`);
  }

  const supabase = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
  );
  const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });

  const episode = await resolveEpisode(appleUrl);

  if (!episode.audioUrl) {
    throw new Error("[422] No audio URL found for this episode.");
  }

  console.error(`"${episode.title}" (${episode.date})`);

  // Check cache
  const { data: cached, error: cacheError } = await supabase
    .from("transcripts")
    .select("transcript_md")
    .eq("id", episode.episodeId)
    .single();

  if (cacheError && cacheError.code !== "PGRST116") {
    // PGRST116 = no rows found (expected cache miss)
    throw new Error(`Supabase error: ${cacheError.message}`);
  }

  if (cached) {
    console.error("Cache hit — using stored transcript.");
    saveMarkdown(episode.episodeId, cached.transcript_md, outputDir);
    return {
      episodeId: episode.episodeId,
      transcriptPath: path.join(outputDir, `${episode.episodeId}-transcript.md`),
      transcriptMd: cached.transcript_md,
    };
  }

  // Transcribe
  const transcript = await transcribe(deepgram, episode.audioUrl);
  const words = transcript.results.channels[0].alternatives[0].words;
  const durationSeconds = episode.durationSeconds || Math.round(transcript.metadata?.duration ?? 0);

  // Build markdown
  const turns = buildSpeakerTurns(words);
  const body = turns
    .map((t) => `**[${formatTime(t.start)}] Speaker ${t.speaker}:** ${t.text}`)
    .join("\n\n");
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

  const transcriptPath = saveMarkdown(episode.episodeId, md, outputDir);
  return { episodeId: episode.episodeId, transcriptPath, transcriptMd: md };
}

// ── CLI shim ──────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const appleUrl = process.argv[2];
  if (!appleUrl) {
    console.error(
      'Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"'
    );
    process.exit(1);
  }
  run(appleUrl).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
