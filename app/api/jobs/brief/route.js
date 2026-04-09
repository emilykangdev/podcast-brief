import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import adminSupabase from "@/libs/supabase/admin.mjs";
import { MAX_EPISODE_SECONDS, creditsNeeded as calcCredits } from "@/libs/credits";
import { verifyEstimate } from "@/libs/estimate-signer";

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

  // Free within 24h of completion. If completed_at is null (shouldn't happen for
  // status=complete, but guard against it), treat as outside the free window.
  const isFreeWindow = completedBrief.completed_at
    ? (Date.now() - new Date(completedBrief.completed_at).getTime()) / (1000 * 60 * 60) <= 24
    : false;
  const regenCost = isFreeWindow ? 0 : (completedBrief.credits_charged ?? 0);

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
    const { episodeUrl, durationSeconds, regenerate, sig } = await req.json();
    if (!episodeUrl) {
      return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });
    }

    const authSupabase = await createClient();
    const { data: { user }, error } = await authSupabase.auth.getUser();
    if (error || !user) {
      console.error("Auth failed:", error?.message ?? "no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
