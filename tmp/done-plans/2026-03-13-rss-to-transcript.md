# Plan: Apple Podcasts URL → Podcast Transcript (Standalone Script)

## Goal

Build `scripts/transcribe.mjs` — a Node.js CLI script that accepts an Apple Podcasts URL
and outputs a speaker-labeled Markdown transcript. Two input modes, no fuzzy search.

```bash
# Specific episode — paste the episode link from Apple Podcasts (has ?i=)
node --env-file=.env.local scripts/transcribe.mjs "https://podcasts.apple.com/us/podcast/revisionist-history/id1143709275?i=1000612345"

# Latest episode — paste the show link (no ?i=)
node --env-file=.env.local scripts/transcribe.mjs "https://podcasts.apple.com/us/podcast/revisionist-history/id1143709275"
```

## Why

- RSS feed URLs are hidden from users — Apple Podcasts links are the natural input
- Episode-specific URLs (`?i=`) contain the iTunes `trackId` → exact episode, no guessing
- Speaker diarization lets GPT-4 know who said what during brief generation
- Supabase caching avoids re-transcribing the same episode (saves Deepgram credits)

## What

**Two modes based on URL shape:**

**Mode A — Episode URL** (has `?i=NNNN`):
- Extract podcast ID + episode `trackId` from URL
- Call iTunes Lookup API with `entity=podcastEpisode` → find episode by `trackId`
- iTunes returns `episodeUrl` (audio), `trackName`, `releaseDate`, `trackTimeMillis` directly
- No RSS parsing needed
- UUID v5 from `trackId` string → cache key

**Mode B — Show URL** (no `?i=`):
- Extract podcast ID from URL
- Call iTunes Lookup API → get `feedUrl` (RSS)
- Parse RSS → take `items[0]` (latest episode)
- UUID v5 from episode `guid` → cache key

**Shared tail (both modes):**
1. Check Supabase cache by UUID — hit → write MD and exit
2. Call Deepgram `nova-2` + `diarize:true` → group words by speaker → build MD
3. Store in Supabase `transcripts` table → write `transcripts/<slug>-<date>.md`

### Success Criteria

- [ ] Episode URL (`?i=`) → exact episode transcribed with no RSS or keyword needed
- [ ] Show URL (no `?i=`) → latest episode transcribed
- [ ] Non-Apple-Podcasts input exits with `[422]` error
- [ ] Invalid iTunes ID exits with clear error
- [ ] Re-running same URL uses Supabase cache (no Deepgram call)
- [ ] Output MD has correct structure: header + timestamped speaker turns

---

## All Needed Context

### Documentation & References

```yaml
- url: https://itunes.apple.com/search?term=test&entity=podcast&limit=1
  why: iTunes Lookup API — no auth, free. Hit /lookup?id=ITUNES_ID to get feedUrl.
  example_response_field: results[0].feedUrl  ← the RSS feed URL

- url: https://developers.deepgram.com/docs/pre-recorded-audio
  why: transcribeUrl method, response shape

- url: https://developers.deepgram.com/docs/diarization
  why: diarize:true, word.speaker field

- file: libs/gpt.js
  why: pattern reference for async API calls with console.log progress

- file: supabase/migrations/20260307133000_create_briefs_table.sql
  why: migration format reference
```

### Current Codebase Tree

```bash
podcast-brief/
├── libs/
│   ├── gpt.js
│   └── supabase/server.js   # cookie-based — NOT usable in CLI
├── supabase/migrations/
│   ├── 20260307132000_init_profiles.sql
│   ├── 20260307133000_create_briefs_table.sql
│   ├── 20260307134000_create_credit_ledger_table.sql
│   └── 20260307135000_create_brief_email_deliveries_table.sql
└── scripts/                 # does not exist yet
```

### Desired Codebase Tree

```bash
podcast-brief/
├── scripts/
│   └── transcribe.mjs                                    ← NEW
├── supabase/migrations/
│   └── 20260313000000_create_transcripts_table.sql       ← NEW
└── transcripts/             ← git-ignored, created at runtime
```

### Known Gotchas & Library Quirks

```js
// CRITICAL: .mjs extension required — package.json has no "type":"module"
// Run with: node --env-file=.env.local scripts/transcribe.mjs <url>
// Must be run from project root (transcripts/ resolves relative to cwd)
// Quote the URL in the shell — ?i= can confuse some shells

// CRITICAL: Detect episode vs show URL
const episodeMatch = appleUrl.match(/[?&]i=(\d+)/);  // episode trackId
const podcastMatch = appleUrl.match(/id(\d+)/);        // podcast collection ID
// episodeMatch[1] = trackId (e.g. "1000612345")
// podcastMatch[1] = collectionId (e.g. "1143709275")

// CRITICAL: Mode A — episode lookup by trackId
// iTunes returns episodes when queried with entity=podcastEpisode on the COLLECTION id.
// Filter results by trackId to find the exact episode.
const res = await fetch(
  `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=200`
);
const json = await res.json();
// results[0] is the podcast show itself; episodes start at index 1
const episode = json.results.find(r => r.trackId === parseInt(trackId));
// episode.episodeUrl      → audio file URL (direct, Deepgram-ready)
// episode.trackName       → episode title
// episode.releaseDate     → ISO date string
// episode.trackTimeMillis → duration in milliseconds
// episode.collectionName  → podcast show name

// CRITICAL: Mode B — show lookup for RSS feedUrl
const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcast`);
const json = await res.json();
const feedUrl = json.results?.[0]?.feedUrl;

// CRITICAL: UUID v5 cache key
// Mode A: uuidv5(trackId, uuidv5.URL)          — trackId is unique across all iTunes
// Mode B: uuidv5(item.guid || audioUrl, uuidv5.URL)

// CRITICAL: Deepgram SDK (context7-verified)
import { createClient as createDeepgram } from "@deepgram/sdk";
const { result, error } = await deepgram.listen.prerecorded.transcribeUrl(
  { url: audioUrl },
  { model: "nova-2", smart_format: true, diarize: true, utterances: true }
);
// Use "nova-2" — confirmed stable. "nova-3" may not be available on all plans.
// Deepgram follows HTTP redirects — tracking prefixes (Podtrac, Chartable) resolve fine.

// CRITICAL: Supabase .single() returns error.code === "PGRST116" for no rows (cache miss).
// Any other error code is a real error — log and exit.

// CRITICAL: word.punctuated_word has punctuation. word.start/end are seconds (floats).
// word.speaker is 0-indexed integer, only present when diarize:true.

// CRITICAL: formatDuration — Mode B itunes duration may be "HH:MM:SS", "MM:SS", or raw seconds.
// Mode A: trackTimeMillis / 1000 → seconds → formatTime()
// Split on ":", left-pad to 3 segments, never use padStart with multi-char fill string.

// CRITICAL: slug fallback — if title is all symbols, slug would be empty.
// Use: slug || "episode"
```

---

## Implementation Blueprint

### Data Model: `transcripts` table

```sql
-- supabase/migrations/20260313000000_create_transcripts_table.sql
-- Transcript cache keyed by deterministic UUID v5 of the episode guid.

create table if not exists public.transcripts (
  id uuid primary key,             -- UUID v5 from episode guid (not auto-generated)
  apple_url text not null,         -- original Apple Podcasts URL provided by user
  rss_url text not null,           -- resolved RSS feed URL from iTunes Lookup API
  episode_guid text not null,
  episode_title text not null,
  episode_date text,
  audio_url text not null,
  duration_seconds integer,
  transcript_md text not null,
  created_at timestamptz not null default now()
);

create index if not exists transcripts_apple_url_idx on public.transcripts (apple_url);

alter table public.transcripts enable row level security;
-- No RLS policies — accessed exclusively via service role key.
```

### Tasks (in implementation order)

```yaml
Task 1: Create Supabase migration
CREATE supabase/migrations/20260313000000_create_transcripts_table.sql
  - Use SQL from Data Model section above verbatim
  - id is uuid primary key — NOT gen_random_uuid()

Task 2: Install dependencies
RUN: npm install @deepgram/sdk rss-parser uuid
  - fetch is built into Node 18+ — no node-fetch needed
  - @supabase/supabase-js already installed

Task 3: Create scripts/transcribe.mjs
  - See pseudocode below

Task 4: Add transcripts/ to .gitignore
MODIFY .gitignore: append "/transcripts"
```

### Per-Task Pseudocode

```js
// scripts/transcribe.mjs
// Usage: node --env-file=.env.local scripts/transcribe.mjs "<apple-podcasts-url>"
// Episode URL (?i=): exact episode. Show URL: latest episode.
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
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "episode";
  const filepath = path.join(outputDir, `${slug}-${date}.md`);
  fs.writeFileSync(filepath, content, "utf8");
  console.log(`Written: ${filepath}`);
}

// ── 1. Validate args & env vars ──────────────────────────────────

const appleUrl = process.argv[2];

if (!appleUrl) {
  console.error("Usage: node --env-file=.env.local scripts/transcribe.mjs \"<apple-podcasts-url>\"");
  process.exit(1);
}

if (!appleUrl.startsWith("https://podcasts.apple.com")) {
  console.error("[422] Input must be an Apple Podcasts URL.");
  console.error("Example: https://podcasts.apple.com/us/podcast/show/id1143709275?i=1000612345");
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

const missingEnv = ["DEEPGRAM_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]
  .filter((k) => !process.env[k]);
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
    console.error("[422] Episode not found in iTunes. The link may be stale or region-locked.");
    process.exit(1);
  }

  audioUrl       = episode.episodeUrl;
  title          = episode.trackName ?? "Untitled";
  date           = episode.releaseDate?.split("T")[0] ?? "unknown-date";
  durationSeconds = Math.round((episode.trackTimeMillis ?? 0) / 1000);
  podcastName    = episode.collectionName ?? "Unknown Podcast";
  rssUrl         = null; // not needed in Mode A
  episodeId      = uuidv5(trackId, uuidv5.URL);

  console.log(`Episode: "${title}" (${date})`);

} else {
  // ── Mode B: Show URL — get RSS feed, use latest episode ─────────
  console.log(`Show URL detected. Fetching latest episode...`);

  const res = await fetch(`https://itunes.apple.com/lookup?id=${collectionId}&entity=podcast`);
  const json = await res.json();
  rssUrl = json.results?.[0]?.feedUrl;

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

  const item = feed.items[0];
  audioUrl        = item.enclosure?.url;
  title           = item.title ?? "Untitled";
  date            = item.isoDate?.split("T")[0] ?? "unknown-date";
  durationSeconds = 0; // will be filled from Deepgram metadata
  podcastName     = feed.title ?? "Unknown Podcast";
  episodeId       = uuidv5(item.guid || audioUrl, uuidv5.URL);

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
let currentSpeaker = null, currentStart = null, currentWords = [];

for (const word of words) {
  if (word.speaker !== currentSpeaker) {
    if (currentWords.length > 0) {
      turns.push({ speaker: currentSpeaker, start: currentStart, text: currentWords.join(" ") });
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
```

---

## Integration Points

```yaml
DATABASE:
  - Create: supabase/migrations/20260313000000_create_transcripts_table.sql
  - Apply: paste into Supabase dashboard SQL editor, or supabase db push
  - No new env vars needed

ENV VARS (all already in .env.local):
  - DEEPGRAM_API_KEY
  - NEXT_PUBLIC_SUPABASE_URL
  - SUPABASE_SECRET_KEY

NEW PACKAGES: @deepgram/sdk, rss-parser, uuid
BUILT-IN:     fetch (Node 18+), fs, path
```

## Validation Loop

```bash
# Mode A — specific episode (paste episode link from Apple Podcasts):
node --env-file=.env.local scripts/transcribe.mjs \
  "https://podcasts.apple.com/us/podcast/revisionist-history/id1143709275?i=1000385564"

# Mode B — latest episode (paste show link):
node --env-file=.env.local scripts/transcribe.mjs \
  "https://podcasts.apple.com/us/podcast/revisionist-history/id1143709275"

# Cache hit — run either command a second time:
# Expected: "Cache hit — using stored transcript."

# Error case — non-Apple URL:
node --env-file=.env.local scripts/transcribe.mjs "https://open.spotify.com/show/abc"
# Expected: [422] Input must be an Apple Podcasts URL.
```

## Final Checklist

- [ ] Migration created and applied in Supabase
- [ ] `npm install @deepgram/sdk rss-parser uuid` completed
- [ ] `/transcripts` added to `.gitignore`
- [ ] Mode A (episode URL) transcribes the exact episode
- [ ] Mode B (show URL) transcribes the latest episode
- [ ] Second run uses cache
- [ ] Non-Apple URL exits with `[422]`

# Real implementation notes

Branch: make-brief

- Manually that getting audio from Apple Podcasts works for different shows 

Note on Apple Podcasts API: 

Direct episode lookup by trackId has never worked in the iTunes API. It's not a      
recent breakage; developer forum threads asking about it go back to 2017 with no resolution. The lookup?id=X endpoint only resolves 
top-level catalog items (podcasts as collections, apps, albums) — episode trackIds are not indexed there. It's the same reason you  
can't look up a song directly; you have to go through the album.                                                                    
                                                                                                                                    
So the current fix (collection + client-side filter by trackId) is the correct and only approach via the iTunes API. The 200-episode
  cap is a real but unavoidable limitation.                                                                                          
                                                                                                                                    
This is true even in 2026. 