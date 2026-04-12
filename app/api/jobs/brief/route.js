import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import adminSupabase from "@/libs/supabase/admin.mjs";
import { MAX_EPISODE_SECONDS, creditsNeeded as calcCredits, getRegenCost } from "@/libs/credits";
import { verifyEstimate } from "@/libs/estimate-signer";
import { getPostHog } from "@/libs/posthog/server";
import arcjet, { shield, tokenBucket, detectBot } from "@arcjet/next";

// Single Arcjet decision for this route: shield + bot detection + rate limit.
// Most sensitive endpoint — consumes credits and triggers expensive Browserbase
// pipeline. Token bucket allows burst of 10 briefs (batch session), then 2/min
// sustained.
const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: "LIVE" }),
    tokenBucket({
      mode: "LIVE",
      refillRate: 2,   // 2 tokens per minute
      interval: 60,    // refill interval in seconds
      capacity: 10,    // max burst size
      characteristics: ["userId"],
    }),
    detectBot({ mode: "LIVE", allow: [] }),
  ],
});

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";

// Regeneration: free within 24h of completion, full price after.
// Pre-credit briefs (credits_charged=null) are always free to regen.
async function handleRegenerate(db, user, episodeUrl) {
  const { data: inProgress } = await db
    .from("briefs")
    .select("id")
    .eq("input_url", episodeUrl)
    .eq("profile_id", user.id)
    .eq("environment", APP_ENV)
    .in("status", ["queued", "generating"])
    .maybeSingle();

  if (inProgress) {
    return NextResponse.json(
      { error: "A brief for this episode is already being generated" },
      { status: 409 }
    );
  }

  const { data: completedBrief } = await db
    .from("briefs")
    .select("id, credits_charged, completed_at")
    .eq("input_url", episodeUrl)
    .eq("profile_id", user.id)
    .eq("environment", APP_ENV)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!completedBrief) {
    return NextResponse.json({ error: "No completed brief found to regenerate" }, { status: 404 });
  }

  const regenCost = getRegenCost(completedBrief.completed_at, completedBrief.credits_charged);

  const { data: result, error: rpcError } = await db.rpc("consume_credits_and_regenerate_brief", {
    p_profile_id: user.id,
    p_brief_id: completedBrief.id,
    p_credits_to_charge: regenCost,
    p_environment: APP_ENV,
  });

  if (rpcError) {
    console.error("RPC error:", rpcError);
    return NextResponse.json({ error: "Failed to queue regeneration" }, { status: 500 });
  }
  if (result.error === "insufficient_credits") {
    return NextResponse.json({
      error: "insufficient_credits",
      creditsRemaining: result.credits_remaining,
      creditsNeeded: regenCost,
    }, { status: 402 });
  }
  if (result.error === "already_regenerated") {
    return NextResponse.json({ error: "This brief has already been regenerated" }, { status: 409 });
  }
  if (result.error) {
    console.error("Unexpected regen RPC error:", result.error);
    return NextResponse.json({ error: "Failed to queue regeneration" }, { status: 500 });
  }

  return NextResponse.json({
    status: "queued",
    briefId: completedBrief.id,
    creditsCharged: result.credits_charged,
    creditsRemaining: result.credits_remaining,
  });
}

export async function POST(req) {
  try {
    const { episodeUrl, durationSeconds, regenerate, sig, episodeTitle, podcastName } = await req.json();
    if (!episodeUrl) {
      return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });
    }

    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      console.error("Auth failed:", error?.message ?? "no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit AFTER auth — tracked per user, not per IP
    const decision = await aj.protect(req, { userId: user.id, requested: 1 });
    if (decision.isDenied()) {
      if (decision.reason.isBot()) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 }
      );
    }

    const { episodeUrl, durationSeconds, regenerate, sig } = await req.json();
    if (!episodeUrl) {
      return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });
    }

    // Admin client for RPC calls (service_role only)
    const db = adminSupabase;

    // Regen path FIRST — regen requests don't send durationSeconds
    if (regenerate) {
      return handleRegenerate(db, user, episodeUrl);
    }

    // New brief — validate durationSeconds server-side (defense in depth)
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_EPISODE_SECONDS) {
      return NextResponse.json({ error: "Invalid or out-of-range episode duration" }, { status: 422 });
    }

    // Verify the estimate signature — prevents clients from forging a low durationSeconds
    // to pay fewer credits. The sig was produced by the estimate endpoint using HMAC.
    if (!sig || !verifyEstimate(episodeUrl, durationSeconds, sig)) {
      return NextResponse.json({
        error: "Detected modification in duration info, please send a request again.",
      }, { status: 422 });
    }

    const needed = calcCredits(durationSeconds);

    // Atomic: dedup check + credit deduction + brief insert + ledger entry (all in one RPC)
    const { data: result, error: rpcError } = await db.rpc("consume_credits_and_queue_brief", {
      p_profile_id: user.id,
      p_episode_url: episodeUrl,
      p_duration_seconds: durationSeconds,
      p_credits_to_charge: needed,
      p_environment: APP_ENV,
    });

    if (rpcError) {
      // 23505 = Postgres unique violation — partial index caught a race condition
      if (rpcError.code === "23505") {
        return NextResponse.json(
          { error: "A brief for this episode is already in progress" },
          { status: 409 }
        );
      }
      console.error("RPC error:", rpcError);
      return NextResponse.json({ error: "Failed to queue brief" }, { status: 500 });
    }

    if (result.error === "already_exists") {
      return NextResponse.json({ error: "You already have a brief for this episode" }, { status: 409 });
    }
    if (result.error === "insufficient_credits") {
      return NextResponse.json({
        error: "insufficient_credits",
        creditsRemaining: result.credits_remaining,
        creditsNeeded: needed,
      }, { status: 402 });
    }
    if (result.error) {
      console.error("Unexpected RPC error:", result.error);
      return NextResponse.json({ error: "Failed to queue brief" }, { status: 500 });
    }

    // Write episode metadata so dashboard shows it immediately while queued.
    // Non-critical — the worker overwrites these fields after transcribe.
    if (episodeTitle || podcastName) {
      try {
        const { error: metadataError } = await db
          .from("briefs")
          .update({ episode_title: episodeTitle || null, podcast_name: podcastName || null })
          .eq("id", result.brief_id)
          .eq("profile_id", user.id)
          .eq("environment", APP_ENV);

        if (metadataError) {
          console.error("Non-critical: failed to write episode metadata:", metadataError.message);
        }
      } catch (metaErr) {
        console.error("Non-critical: failed to write episode metadata:", metaErr.message);
      }
    }
    const posthog = getPostHog();
    posthog?.capture({
      distinctId: user.id,
      event: "brief_queued",
      properties: { episode_url: episodeUrl },
    });
    posthog?.flush().catch((e) => console.error("[posthog] flush failed:", e.message));

    return NextResponse.json({
      status: "queued",
      briefId: result.brief_id,
      creditsCharged: result.credits_charged,
      creditsRemaining: result.credits_remaining,
    });
  } catch (e) {
    console.error("Unhandled error in /api/jobs/brief:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
