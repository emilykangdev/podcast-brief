# Plan: Download-First Transcription

## Goal

Fix Deepgram transcription failures caused by podcast CDN bot detection. Download audio to a temp file with a podcast-app User-Agent, then send the file to Deepgram via `transcribeFile()`. Fall back to URL-based `transcribeUrl()` if download fails.

**One file change: `scripts/transcribe.mjs`.**

## Why

- Megaphone (Spotify), Acast, and Cloudflare-fronted podcast CDNs block Deepgram's servers (bot detection, IP blocklists, UA filtering)
- Downloading ourselves with a podcast-app UA bypasses all CDN restrictions
- Two episodes already failed in production: Joe Rogan #2480 and WAN Show 2026-02-27, both with `Deepgram error: invalid_argument`

## Success Criteria

- [ ] Previously-failed episodes (Joe Rogan, WAN Show) transcribe successfully
- [ ] Audio is streamed to disk (not buffered in memory) for 200MB+ files
- [ ] If download fails, falls back to `transcribeUrl()` before failing
- [ ] HTML bot-challenge pages detected and rejected early
- [ ] Audio file cleaned up after transcription (both worker and CLI)
- [ ] Cached transcripts still skip download entirely
- [ ] `npm run build` / `npm run lint` pass

## Files touched

```bash
scripts/
  transcribe.mjs                     ← MODIFIED
```

## Known Gotchas

```javascript
// CRITICAL: Deepgram SDK v5 file API path is:
//   deepgram.listen.v1.media.transcribeFile(readableStream, { model, ... })
// NOT deepgram.listen.prerecorded.transcribeFile (that's the docs, not the SDK).
// Response shape is IDENTICAL to transcribeUrl() — no parsing changes needed.

// CRITICAL: Use stream.pipeline() from node:stream/promises for download.
// Manual for-await + write() silently drops chunks on backpressure.

// CRITICAL: Some CDNs (Acast, Cloudflare) block default Node fetch UA.
// Use podcast-app UA: "AntennaPod/3.1.2"

// CRITICAL: Some CDNs return HTTP 200 with an HTML bot-challenge page.
// Check Content-Type after response — if text/html, abort immediately.

// CRITICAL: Node fetch response.body is a web ReadableStream.
// stream.pipeline() needs a Node Readable. Use Readable.fromWeb() to convert.

// CRITICAL: fs.createReadStream for Deepgram input — NOT readFileSync.
// 225MB files would double peak RSS with readFileSync.
```

## Architecture Overview

```
Before:
  cache check → miss → transcribeUrl(audioUrl)      ← Deepgram fetches from CDN (blocked)

After:
  cache check → miss → downloadAudio(audioUrl)       ← WE fetch with podcast-app UA
                      → transcribeFile(readStream)    ← Deepgram gets raw audio
                      → cleanup temp file
                    OR (if download fails)
                      → transcribeUrl(audioUrl)       ← fallback: let Deepgram try directly
                      → (if that fails too, throw)
```

## Tasks

```yaml
Task 1 — Add downloadAudio() helper:
  ADD function downloadAudio(audioUrl, outputDir) to scripts/transcribe.mjs:
    - fetch() with User-Agent: "AntennaPod/3.1.2"
    - AbortSignal.timeout(600_000) — 10 min for large files on slow CDNs
    - Check res.ok — throw on HTTP errors with status code
    - Check Content-Type — if starts with "text/html", throw "CDN returned HTML
      instead of audio — likely a bot-challenge page"
    - Log file size if Content-Length header present
    - Stream to disk via stream.pipeline(Readable.fromWeb(res.body), fs.createWriteStream(path))
    - Return the file path
    - File name: "episode-audio.bin" (Deepgram reads codec from audio headers, not filename)

Task 2 — Modify transcribe() for file-first with URL fallback:
  REPLACE the existing transcribe(deepgram, audioUrl) function:
    - New signature: transcribe(deepgram, audioFilePath, audioUrl)
    - Try file-based first:
        const stream = fs.createReadStream(audioFilePath)
        return await deepgram.listen.v1.media.transcribeFile(stream, {
          model: "nova-2", smart_format: true, diarize: true, utterances: true
        })
    - If file-based throws, log warning and fall back to URL-based:
        console.error("File transcription failed, falling back to URL...")
        return await deepgram.listen.v1.media.transcribeUrl({
          url: audioUrl, model: "nova-2", smart_format: true, diarize: true, utterances: true
        })
    - If both fail, throw the original error

Task 3 — Wire download into run() with cleanup:
  MODIFY run() function:
    - After cache check (existing line 103), before transcribe call (existing line 116):
    - Add: let audioFilePath = null;
    - Try to download:
        try {
          audioFilePath = await downloadAudio(episode.audioUrl, outputDir);
        } catch (dlErr) {
          console.error("Download failed, will try URL-based transcription:", dlErr.message);
        }
    - Pass both to transcribe:
        const transcript = await transcribe(deepgram, audioFilePath, episode.audioUrl);
    - Cleanup in finally:
        if (audioFilePath) {
          fs.promises.unlink(audioFilePath).catch(() => {});
        }
    - The unlink is best-effort — worker's jobDir cleanup is the real safety net
```

## Key Pseudocode

```javascript
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const DOWNLOAD_UA = "AntennaPod/3.1.2";
const DOWNLOAD_TIMEOUT_MS = 600_000; // 10 minutes

async function downloadAudio(audioUrl, outputDir) {
  console.error("Downloading audio...");

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
  return audioPath;
}

async function transcribe(deepgram, audioFilePath, audioUrl) {
  console.error("Transcribing via Deepgram (this may take a few minutes)...");

  const opts = { model: "nova-2", smart_format: true, diarize: true, utterances: true };

  // Try file-based first (CDN-proof)
  if (audioFilePath) {
    try {
      return await deepgram.listen.v1.media.transcribeFile(
        fs.createReadStream(audioFilePath),
        opts
      );
    } catch (err) {
      console.error(`File transcription failed (${err.message}), falling back to URL...`);
    }
  }

  // Fallback: let Deepgram fetch the URL directly
  try {
    return await deepgram.listen.v1.media.transcribeUrl({ url: audioUrl, ...opts });
  } catch (err) {
    throw new Error(`Deepgram error: ${err.message ?? err}`);
  }
}

// In run(), after cache check:
let audioFilePath = null;
try {
  audioFilePath = await downloadAudio(episode.audioUrl, outputDir);
} catch (dlErr) {
  console.error("Download failed, will try URL-based transcription:", dlErr.message);
}

try {
  const transcript = await transcribe(deepgram, audioFilePath, episode.audioUrl);
  // ... rest of run() unchanged ...
} finally {
  if (audioFilePath) {
    fs.promises.unlink(audioFilePath).catch(() => {});
  }
}
```

## Validation Loop

```bash
npm run build
npm run lint

# Test 1: Previously-failed episode (should now download + transcribe)
node --env-file=.env.local scripts/transcribe.mjs "https://podcasts.apple.com/us/podcast/2480-arsenio-hall/id360084272?i=1000760297100"

# Test 2: Already-cached episode (should skip download entirely)
node --env-file=.env.local scripts/transcribe.mjs "https://podcasts.apple.com/us/podcast/trump-iran-ceasefire-iran-on-trumps-reversal-markets/id1222114325?i=1000760229841"

# Test 3: Queue the failed brief via Supabase, verify worker picks it up and completes
```

## Deprecated Code

- Direct `transcribeUrl()` as the primary path (now only used as fallback)

## Confidence Score

**9/10** — Single file, well-understood API swap, clear pseudocode, all decisions pre-made in the brief. Only risk: `Readable.fromWeb()` compatibility on the Railway Node version (should be fine on Node 18+).
