import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { resolveEpisode } from "@/libs/podcast/resolve.mjs";
import { MAX_EPISODE_SECONDS, creditsNeeded, formatDuration } from "@/libs/credits";
import { signEstimate } from "@/libs/estimate-signer";
import arcjet, { shield, slidingWindow } from "@arcjet/next";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    slidingWindow({
      mode: "LIVE",
      interval: "1m",
      max: 30,
      characteristics: ["userId"],
    }),
  ],
});

export async function POST(req) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Rate limit AFTER auth — tracked per user, 30 requests/min allows rapid
  // URL experimentation without enabling scripted abuse
  const decision = await aj.protect(req, { userId: user.id });
  if (decision.isDenied()) {
    if (!decision.reason.isRateLimit()) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429 }
    );
  }

  const { episodeUrl } = await req.json();
  if (!episodeUrl) return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });

  let episode;
  try {
    episode = await resolveEpisode(episodeUrl);
  } catch (err) {
    const status = err.message?.startsWith("[422]") ? 422 : 500;
    if (status === 500) {
      console.error("resolveEpisode failed:", err.message, err.stack);
    }
    return NextResponse.json({
      error: "episode_not_found",
      message: status === 422
        ? "Couldn't find this episode. Make sure the link is from Apple Podcasts and points to a specific episode (look for `?i=` in the URL)."
        : "Something went wrong resolving this episode. Please try again.",
    }, { status });
  }

  if (!episode.durationSeconds) {
    return NextResponse.json({
      error: "duration_unknown",
      message: "Couldn't determine the length of this episode. Try a different link or contact support.",
    }, { status: 422 });
  }

  if (episode.durationSeconds > MAX_EPISODE_SECONDS) {
    return NextResponse.json({
      error: "episode_too_long",
      message: `This episode is ${formatDuration(episode.durationSeconds)}. We currently support podcasts up to 4 hours.`,
      durationSeconds: episode.durationSeconds,
      maxDurationSeconds: MAX_EPISODE_SECONDS,
    }, { status: 422 });
  }

  const needed = creditsNeeded(episode.durationSeconds);
  const { data: profile } = await supabase.from("profiles").select("credits").eq("id", user.id).single();
  const remaining = profile?.credits ?? 0;

  if (remaining < needed) {
    return NextResponse.json({
      error: "insufficient_credits",
      message: `This episode is ${formatDuration(episode.durationSeconds)} and costs ${needed} credit${needed > 1 ? "s" : ""}. You have ${remaining} credit${remaining !== 1 ? "s" : ""} remaining.`,
      durationSeconds: episode.durationSeconds,
      creditsNeeded: needed,
      creditsRemaining: remaining,
      creditsShort: needed - remaining,
    }, { status: 402 });
  }

  return NextResponse.json({
    durationSeconds: episode.durationSeconds,
    creditsNeeded: needed,
    creditsRemaining: remaining,
    episodeTitle: episode.title,
    podcastName: episode.podcastName,
    sig: signEstimate(episodeUrl, episode.durationSeconds),
  });
}
