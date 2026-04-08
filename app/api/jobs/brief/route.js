import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";

const APP_ENV = process.env.APP_ENV || "DEVELOPMENT";

// Resets a completed brief back to queued for re-processing.
// Each brief can only be regenerated once (enforced atomically via regeneration_count).
async function handleRegenerate(supabase, user, episodeUrl) {
  // Block if a brief for this episode is already in progress
  const { data: inProgress } = await supabase
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
  const { data: completedBrief } = await supabase
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
  const { data: updated, error: updateError } = await supabase
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

    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) {
      console.error("Auth failed:", error?.message ?? "no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (regenerate) {
      return handleRegenerate(supabase, user, episodeUrl);
    }

    // Dedup check: reject if a brief for this episode is already in progress
    const { data: existing } = await supabase
      .from("briefs")
      .select("id")
      .eq("input_url", episodeUrl)
      .eq("profile_id", user.id)
      .eq("environment", APP_ENV)
      .in("status", ["queued", "generating"])
      .maybeSingle();

    if (existing) {
      return NextResponse.json(
        { error: "A brief for this episode is already in progress" },
        { status: 409 }
      );
    }

    const { data: brief, error: insertError } = await supabase
      .from("briefs")
      .insert({
        profile_id: user.id,
        input_url: episodeUrl,
        status: "queued",
        environment: process.env.APP_ENV || "DEVELOPMENT",
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
