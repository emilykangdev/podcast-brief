import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";

export async function POST(req) {
  try {
    const { episodeUrl } = await req.json();
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

    // Dedup check: reject if a brief for this episode is already in progress
    const { data: existing } = await supabase
      .from("briefs")
      .select("id")
      .eq("input_url", episodeUrl)
      .eq("profile_id", user.id)
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
