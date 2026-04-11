# Brief: Download-First Transcription

## Why
Deepgram's servers get blocked by podcast CDN bot detection (Megaphone/Spotify, Acast, Cloudflare-fronted hosts). The current flow gives Deepgram the audio URL and lets them fetch it — CDNs reject Deepgram's server IPs/UA. Downloading the audio ourselves with a podcast-app User-Agent bypasses all CDN restrictions.

## Context
- **Deepgram SDK v5 file API:** `deepgram.listen.v1.media.transcribeFile(readStream, { model, ... })` — same namespace as `transcribeUrl()`, accepts `ReadStream`, response shape identical
- **CDN behavior:** Most CDNs allow server-side downloads with a proper UA. Acast actively blocks bot UAs. Megaphone (Spotify) appears to block Deepgram's servers specifically. iTunes API URLs don't expire — they're passthrough to host CDNs.
- **File sizes:** 30min ≈ 28MB, 1h ≈ 56MB, 4h ≈ 225MB. Must stream to disk, not buffer in memory.
- **Affected file:** Only `scripts/transcribe.mjs` — add `downloadAudio()` helper, modify `transcribe()`, wire in `run()`
- **No new dependencies.** Node built-in `fetch()` + `fs.createWriteStream()` + `stream.pipeline()` + `fs.createReadStream()`

## Decisions
- **User-Agent:** `AntennaPod/3.1.2` (podcast-app style, passes Acast/CDN bot detection)
- **File input method:** `fs.createReadStream(path)` passed to `transcribeFile()` (proven pattern, memory-safe for 225MB files)
- **Fallback strategy:** If download fails, still try `transcribeUrl()` as a last resort before failing. Some CDNs may work fine with Deepgram directly — no reason to break those.
- **Download timeout:** 600s (225MB on a slow CDN could take a while)
- **Content-Type guard:** Check response Content-Type after download — if `text/html`, throw immediately (CDN returned a bot-challenge page, not audio)
- **Cleanup:** Delete audio file in a `finally` block after transcribe. Worker's jobDir cleanup handles it for pipeline runs; explicit unlink needed for CLI runs.
- **Filename:** Use `episode-audio.bin` (not `.mp3`) — Deepgram identifies codec from audio container headers, not filename. Avoids issues with M4A/OGG served by some CDNs.
- **Stream to disk:** Use `stream.pipeline()` from `node:stream/promises` — handles backpressure and teardown correctly (not manual `for await` + `write()`)

## Rejected Alternatives
- **`readFileSync` into Buffer** — doubles peak memory on 200MB files. Use ReadStream instead.
- **`{ path: string }` SDK shortcut** — underdocumented, ReadStream is the proven pattern
- **Download only, no URL fallback** — some CDNs may work fine with Deepgram directly, no reason to break those cases
- **New libraries (axios, got, undici)** — Node built-in fetch + streams are sufficient

## Direction
Modify `scripts/transcribe.mjs` only. Add `downloadAudio()` that streams audio to a temp file with AntennaPod UA + 600s timeout + Content-Type guard. Change `transcribe()` to try file-based first (`transcribeFile` with `createReadStream`), fall back to URL-based (`transcribeUrl`) if download fails. Wire into `run()` after the cache check. Clean up audio file in a `finally` block.
