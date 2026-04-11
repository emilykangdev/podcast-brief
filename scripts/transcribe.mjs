// Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"
// Episode URL (?i=): transcribes exact episode. Show URL: transcribes latest episode.

import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { DeepgramClient } from "@deepgram/sdk";
import supabase from "../libs/supabase/admin.mjs";
import { resolveEpisode } from "../libs/podcast/resolve.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DOWNLOAD_UA = "AntennaPod/3.1.2";
const DOWNLOAD_TIMEOUT_MS = 600_000; // 10 minutes

function ensureOutputDir(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ── Download ─────────────────────────────────────────────────────

async function downloadAudio(audioUrl, outputDir) {
  console.error("Downloading audio...");
  ensureOutputDir(outputDir);

  const res = await fetch(audioUrl, {
    headers: { "User-Agent": DOWNLOAD_UA },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`[${res.status}] Failed to download audio from ${new URL(audioUrl).hostname}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.startsWith("text/html")) {
    throw new Error("CDN returned HTML instead of audio — likely a bot-challenge page");
  }

  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    console.error(`Audio file size: ${(parseInt(contentLength) / 1_000_000).toFixed(1)} MB`);
  }

  const audioPath = path.join(outputDir, "episode-audio.bin");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(audioPath));
  console.error("Download complete.");
  return audioPath;
}

// ── Transcription ─────────────────────────────────────────────────

async function transcribe(deepgram, audioFilePath, audioUrl) {
  console.error("Transcribing via Deepgram (this may take a few minutes)...");

  const opts = { model: "nova-2", smart_format: true, diarize: true, utterances: true };
  const reqOpts = { timeoutInSeconds: 600 }; // 10 min — large files need upload + processing time

  // Try file-based first (CDN-proof)
  let fileError = null;
  if (audioFilePath) {
    try {
      return await deepgram.listen.v1.media.transcribeFile(
        fs.createReadStream(audioFilePath),
        opts,
        reqOpts
      );
    } catch (err) {
      fileError = err;
      console.error(`File transcription failed (${err.message}), falling back to URL...`);
    }
  }

  // Fallback: let Deepgram fetch the URL directly
  try {
    return await deepgram.listen.v1.media.transcribeUrl({ url: audioUrl, ...opts }, reqOpts);
  } catch (urlError) {
    const msg = fileError
      ? `Deepgram file error: ${fileError.message}; URL fallback error: ${urlError.message ?? urlError}`
      : `Deepgram error: ${urlError.message ?? urlError}`;
    throw new Error(msg);
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
  ensureOutputDir(outputDir);
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
      podcastName: episode.podcastName,
      episodeTitle: episode.title,
    };
  }

  // Download audio to disk (bypass CDN bot detection)
  let audioFilePath = null;
  try {
    audioFilePath = await downloadAudio(episode.audioUrl, outputDir);
  } catch (dlErr) {
    console.error("Download failed, will try URL-based transcription:", dlErr.message);
  }

  // Transcribe (file-first, URL fallback)
  try {
    const transcript = await transcribe(deepgram, audioFilePath, episode.audioUrl);
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
    return { episodeId: episode.episodeId, transcriptPath, transcriptMd: md, podcastName: episode.podcastName, episodeTitle: episode.title };
  } finally {
    if (audioFilePath) {
      fs.promises.unlink(audioFilePath).catch(() => {});
    }
  }
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
