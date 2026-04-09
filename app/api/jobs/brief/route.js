import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import adminSupabase from "@/libs/supabase/admin.mjs";

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";

// Resets a completed brief back to queued for re-processing.
// Each brief can only be regenerated once (enforced atomically via regeneration_count).
// TODO(Session 3): Replace this manual UPDATE with consume_credits_and_regenerate_brief() RPC
// to add credit deduction (free within 24h, full price after). The RPC already exists in
// the migration but isn't wired up yet because the credit flow depends on Sessions 2-3.
async function handleRegenerate(db, user, episodeUrl) {
  // Only block queued/generating — not complete. The new-brief path blocks ALL statuses
  // (including complete) to prevent duplicates. But regeneration needs a completed brief
  // to exist — it just can't be already re-queued or re-generating.
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

  // Find the completed brief
  const { data: completedBrief } = await db
    .from("briefs")
    .select("id")
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

  // Atomic reset — WHERE includes regeneration_count = 0 so only the first
  // request wins (prevents TOCTOU race if user double-clicks).
  // Keep output_markdown — if the new pipeline fails, the user still has their
  // original brief. The worker overwrites it on success anyway.
  const { data: updated, error: updateError } = await db
    .from("briefs")
    .update({
      status: "queued",
      references: null,
      error_log: null,
      started_at: null,
      completed_at: null,
      regeneration_count: 1,
    })
    .eq("id", completedBrief.id)
    .eq("regeneration_count", 0)
    .select("id");

  if (updateError) {
    console.error("Failed to queue regeneration:", updateError.message);
    return NextResponse.json({ error: "Failed to queue regeneration" }, { status: 500 });
  }

  if (!updated?.length) {
    return NextResponse.json({ error: "This brief has already been regenerated" }, { status: 409 });
  }

  return NextResponse.json({ status: "queued", briefId: completedBrief.id });
}

export async function POST(req) {
  try {
    const { episodeUrl, regenerate } = await req.json();
    if (!episodeUrl) {
      return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });
    }

    const authSupabase = await createClient();
    const {
      data: { user },
      error,
    } = await authSupabase.auth.getUser();
    if (error || !user) {
      console.error("Auth failed:", error?.message ?? "no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // All privileged brief writes happen through the admin client after we bind
    // every query/mutation to the authenticated user's id.
    const db = adminSupabase;

    if (regenerate) {
      return handleRegenerate(db, user, episodeUrl);
    }

    // Dedup check: reject if a brief for this episode already exists (any status)
    const { data: existing } = await db
      .from("briefs")
      .select("id, status")
      .eq("input_url", episodeUrl)
      .eq("profile_id", user.id)
      .eq("environment", APP_ENV)
      .limit(1)
      .maybeSingle();

    if (existing) {
      const message = existing.status === "complete"
        ? "You already have a brief for this episode"
        : "A brief for this episode is already in progress";
      return NextResponse.json({ error: message }, { status: 409 });
    }

    const { data: brief, error: insertError } = await db
      .from("briefs")
      .insert({
        profile_id: user.id,
        input_url: episodeUrl,
        status: "queued",
        environment: APP_ENV,
      })
      .select("id")
      .single();

    if (insertError) {
      // Unique partial index catches the race condition the SELECT check can't
      if (insertError.code === "23505") {
        return NextResponse.json(
          { error: "A brief for this episode is already in progress" },
          { status: 409 }
        );
      }
      console.error("Failed to insert brief:", insertError.message);
      return NextResponse.json({ error: "Failed to queue brief" }, { status: 500 });
    }

    return NextResponse.json({ status: "queued", briefId: brief.id });
  } catch (e) {
    console.error("Unhandled error in /api/jobs/brief:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
