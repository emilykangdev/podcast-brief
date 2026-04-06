import { createClient } from "@/libs/supabase/server";
import ButtonAccount from "@/components/ButtonAccount";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: briefs } = await supabase
    .from("briefs")
    .select("id, input_url, output_markdown, status, podcast_name, episode_title, created_at, completed_at, regeneration_count, error_log")
    .eq("profile_id", user.id)
    .order("created_at", { ascending: false });

  const hydrated = await hydrateMissingMetadata(briefs ?? [], supabase);

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-4xl mx-auto space-y-8">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-extrabold">Your Briefs</h1>
          <ButtonAccount />
        </div>
        <DashboardClient briefs={hydrated} />
      </section>
    </main>
  );
}

// Backfills podcast_name/episode_title for old briefs missing metadata.
// New briefs get metadata from the worker (server.mjs) after transcribe — this
// only runs for legacy rows. Capped at 3 per page load with a 5s timeout to
// avoid blocking SSR. Persists to Supabase so each brief is only fetched once.
const HYDRATION_BATCH_SIZE = 3;
const HYDRATION_TIMEOUT_MS = 5000;

async function hydrateMissingMetadata(briefs, supabase) {
  const needsHydration = briefs.filter(b => !b.podcast_name && b.input_url);
  if (needsHydration.length === 0) return briefs;

  // Only hydrate a few per page load to keep SSR fast — the rest get picked up
  // on subsequent visits as the user refreshes.
  const batch = needsHydration.slice(0, HYDRATION_BATCH_SIZE);

  const results = await Promise.allSettled(
    batch.map(async (brief) => {
      // Parse collectionId and trackId from Apple Podcasts URL:
      // https://podcasts.apple.com/us/podcast/.../id{collectionId}?i={trackId}
      const match = brief.input_url.match(/\/id(\d+)/);
      const trackMatch = brief.input_url.match(/[?&]i=(\d+)/);
      // Skip show URLs (no ?i=) — can't reliably determine which episode was transcribed
      if (!match || !trackMatch) return brief;

      const collectionId = match[1];
      const trackId = trackMatch[1];
      const itunesRes = await fetch(
        `https://itunes.apple.com/lookup?id=${collectionId}&entity=podcastEpisode&limit=200`,
        { signal: AbortSignal.timeout(HYDRATION_TIMEOUT_MS) }
      );
      const { results: itunesResults } = await itunesRes.json();
      const episode = itunesResults?.find(r => String(r.trackId) === trackId);

      // Only persist real data — leave null so hydration retries next page load
      if (!episode) return brief;

      const podcastName = episode.collectionName ?? null;
      const episodeTitle = episode.trackName ?? null;
      if (!podcastName) return brief;

      await supabase
        .from("briefs")
        .update({ podcast_name: podcastName, episode_title: episodeTitle })
        .eq("id", brief.id);

      return { ...brief, podcast_name: podcastName, episode_title: episodeTitle };
    })
  );

  const hydratedMap = new Map();
  results.forEach((r, i) => {
    if (r.status === "fulfilled") hydratedMap.set(batch[i].id, r.value);
  });

  return briefs.map(b => hydratedMap.get(b.id) ?? b);
}
