// Shared episode resolution — used by both the Next.js estimate endpoint and the Railway worker.
// Extracted from scripts/transcribe.mjs.

import { v5 as uuidv5 } from "uuid";
import Parser from "rss-parser";

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

export async function resolveEpisode(url) {
  const collectionId = url.match(/id(\d+)/)?.[1];
  if (!collectionId) {
    throw new Error("[422] Invalid Apple Podcast show or episode link.");
  }

  const trackId = url.match(/[?&]i=(\d+)/)?.[1];
  return trackId ? resolveFromEpisodeUrl(collectionId, trackId) : resolveFromShowUrl(collectionId);
}
