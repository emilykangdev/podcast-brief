# Brief: YouTube video → brief (user-facing, production-grade)

## Why

Extend the brief pipeline beyond Apple Podcasts. Many of the high-signal long-form interviews and lectures the ICP cares about (high-income, time-poor power listeners) live on YouTube and have no podcast feed. Today this is a manual workaround.

The feature must be **production-grade and user-facing**: full credit + estimate + dedup + dashboard parity with the Apple flow, not a CLI/admin tool.

This is also explicitly the **first of many sources** — Spotify, web articles, generic RSS likely follow. The architecture should make the second source easy to add, not bake YouTube into the pipeline shape.

## Context

### Current pipeline (README.md is ground truth)

5 sequential steps in `server.mjs` on Railway:
1. **Transcribe** (`scripts/transcribe.mjs`) — `resolveEpisode(appleUrl)` → download audio with podcast UA → Deepgram file transcription (with URL fallback).
2. **Generate brief** (`scripts/generate-brief.mjs`) — OpenRouter LLM, takes a transcript markdown.
3. **Enrich references** (`scripts/enrich-references.mjs`) — Exa search.
4. **Validate references** (`scripts/validate-references.mjs`) — Browserbase.
5. **Merge references** (`scripts/merge-references.mjs`).

Steps 2–5 are source-agnostic — they take a transcript markdown and don't care where it came from. **Only step 1 needs a new branch.**

### Submission flow (Vercel API routes)

- `POST /api/jobs/brief/estimate` — resolves episode via iTunes API, returns `{ durationSeconds, creditsNeeded, episodeTitle, podcastName, sig }`. Sig is HMAC over `episodeUrl|durationSeconds` with `STRIPE_SECRET_KEY` to prevent tampering.
- `POST /api/jobs/brief` — verifies HMAC, deducts credits atomically via `consume_credits_and_queue_brief` RPC, inserts brief row at `status="queued"`. Vercel and Railway never talk directly — Supabase is the queue.

### Constraints / decisions baked into the system

- **4-hour cap** on episodes (Deepgram synchronous processing limit) — applies to YouTube too.
- **1 credit / hour of audio**, rounded up. Estimate at submission time, no auto-refund on failure.
- **Browserbase free tier: 1 concurrent session**, single Railway worker, jobs serialized via Supabase polling.
- **`.mjs` for worker code, `.js` for Next.js, never cross.** Shared code in `.mjs`.
- **Dedup**: today on raw `input_url + profile_id + environment`. Will need to canonicalize to a source ID for YouTube (multiple URL forms collapse to same video).
- **Schema**: `transcripts` has Apple-specific fields (`apple_url`, `rss_url`, `episode_guid`); `briefs.podcast_name` / `episode_title` will be repurposed for channel / video title.

### Existing scripts created this session (kept public, generic)

- `scripts/download_video.py` — yt-dlp wrapper, currently downloads full mp4. **Will be moved to private repo** as part of phase 1.
- `scripts/transcribe-file.mjs` — Deepgram file transcription, generic. **Stays public** — it's a reusable Deepgram wrapper.

## Decisions

- **Two-phase delivery, ASAP between phases.**
  - **Phase 1**: yt-dlp wrapper as a private GitHub repo installed as an npm package via deploy key, runs in-process in the existing Railway worker, downloads from Railway IPs. Validates the feature end-to-end with minimal infrastructure work.
  - **Phase 2**: Extract the wrapper into its own private Railway service with a Wireguard sidecar (Mullvad). Main worker calls it via HTTP. Public-app code only changes from `import` to `await fetch(DOWNLOADER_URL)`.
  - *Why*: Phase 1 is a couple of hours and de-risks the feature itself. Phase 2 is real infra work and shouldn't block validating the user flow.

- **Audio-only download.** yt-dlp `format: 'bestaudio[ext=m4a]/bestaudio'` → ~15 MB single stream, no ffmpeg merge needed.
  - *Why*: We never render the video. Audio-only cuts bandwidth ~10x, removes the ffmpeg dep from the downloader image, and is materially less "we're downloading videos" optically.

- **Estimate via YouTube Data API v3 (free quota, runs on Vercel).** No yt-dlp on the estimate hot path. yt-dlp is only invoked at download time, behind the private boundary.
  - *Why*: Cleanly separates the public, fast, low-risk metadata lookup from the download step. Keeps the public repo free of yt-dlp on the request path. 10K units/day quota is plenty (1 unit per video).

- **Phase 2 audio transport: stream bytes back in HTTP response.** Headers carry metadata (`X-Source-Title`, `X-Source-Channel`, `X-Source-Duration-Seconds`). Single endpoint `POST /download { url }`.
  - *Why*: Simplest possible contract. No storage, no signed URLs, no second hop.
  - *Fallback*: Move to Supabase Storage + signed URL if streaming proves flaky in practice.

- **Service-to-service auth: shared secret header** (`X-Internal-Auth`) between worker and downloader service.
  - *Why*: Both services are private and in our control. Mutual TLS or OAuth client creds are overkill for two boxes we own.

- **Generic interface from day one.** Endpoint name and contract is `POST /fetch-audio { url }`, not `/fetch-youtube-audio`. Service dispatches internally on URL pattern.
  - *Why*: User explicitly said "first of many" — Spotify/web-article/RSS will be added. The interface should let the next source be a server-side dispatch, not a new endpoint.

- **Schema: add `source_type` enum + `source_id` to `transcripts`. Make Apple-specific columns nullable.** Reuse `briefs.podcast_name` / `episode_title` columns for channel / video title.
  - *Why*: Avoids a rename migration. Column names become slightly misleading but the cost of renaming (touching every read site) outweighs the benefit.

- **Dedup on canonical source ID, not raw URL.** Submission canonicalizes (e.g., extract YouTube video ID from any URL form) before checking dedup.
  - *Why*: `youtu.be/X`, `youtube.com/watch?v=X`, and `…?v=X&list=Y` all refer to the same brief. Raw URL dedup misses this.

- **4-hour cap stays. Same `Math.ceil(duration / 3600)` credit math.**
  - *Why*: Deepgram synchronous limit applies regardless of source.

- **No URL fallback for YouTube transcription.** Deepgram can't fetch YouTube watch pages — they're not direct media URLs. If the file download fails, the brief fails.
  - *Why*: The Apple path has a fallback because the audio URL *is* a direct media URL Deepgram can pull. YouTube has no equivalent. Keep the failure mode simple.

- **Reject live streams, age-restricted, members-only, region-locked at estimate time.**
  - *Why*: yt-dlp will fail on these later anyway. Catching at estimate prevents wasted credits and gives the user a clear message.

- **Install `deno` in the Phase 1 Railway worker image** to enable yt-dlp's JS challenge solving (the `n` challenge).
  - *Why*: We saw the warning during testing — without it, "some formats may be missing." Cheap insurance for Phase 1 reliability before Phase 2's residential-IP help arrives.

- **VPN provider: Mullvad Wireguard, baked into the downloader's Dockerfile.**
  - *Why*: Cash-pay, no PII, well-documented in containers. Wireguard rather than OpenVPN for performance and simpler config.

## Rejected Alternatives

- **Git submodule for the private wrapper** — rejected vs private npm package. Submodules complicate Railway's build cache and version pinning is awkward. Deploy-key + private npm package is cleaner.
- **Calling the private downloader for metadata too** (yt-dlp `--no-download --print`) — rejected. Puts yt-dlp on the estimate hot path, makes Vercel→Railway service traffic synchronous to user requests, and adds a failure mode to the most-called endpoint. YouTube Data API is the right tool.
- **Supabase Storage for Phase 2 audio handoff** — deferred, not rejected. Streaming is simpler; revisit if streaming proves flaky.
- **YouTube-specific endpoint `/fetch-youtube-audio`** — rejected per user direction ("first of many"). Generic `/fetch-audio` keeps the door open for Spotify/web/RSS without an interface migration.
- **Renaming `podcast_name` / `episode_title` columns** — rejected. Cost > benefit; touches too many read sites for a cosmetic improvement.
- **Skipping `deno` in Phase 1** — rejected. The bot-detection warnings during testing are real production risk; one image-build line fixes it.
- **Letting the existing dedup (raw URL) work for YouTube** — rejected. Same video has too many URL forms; users would pay twice.

## Direction

Ship Phase 1 first: private-repo yt-dlp wrapper installed as an npm package in the existing Railway worker, audio-only downloads, full user-facing flow with YouTube Data API v3 for the estimate, schema migration adding `source_type` + `source_id`, canonical-ID dedup, and a URL-pattern dispatcher in the submission API. Validate end-to-end. Then immediately ship Phase 2: extract the downloader into its own private Railway service with Mullvad Wireguard sidecar, single `POST /fetch-audio { url }` endpoint that streams audio bytes back. Public app changes from `import` to `fetch`. Generalize from there to Spotify / web articles / RSS.
