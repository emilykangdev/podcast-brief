import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";
import { cleanUrl } from "@/libs/url";

export async function POST(req) {
  try {
    const { episodeUrl } = await req.json();
    if (!episodeUrl) {
      return NextResponse.json({ error: "episodeUrl required" }, { status: 400 });
    }

    // Get authenticated user server-side
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    if (error || !user) {
      console.error("Auth failed:", error?.message ?? "no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const workerUrl = `${cleanUrl("WORKER_URL")}/jobs/brief`;
    console.log("Calling worker:", workerUrl);

    // Proxy to Railway worker — WORKER_SECRET never sent to browser
    const workerRes = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WORKER_SECRET}`,
      },
      body: JSON.stringify({ episodeUrl, profileId: user.id }),
    });

    if (!workerRes.ok) {
      const err = await workerRes.json().catch(() => ({}));
      console.error("Worker error:", workerRes.status, err);
      return NextResponse.json({ error: err.error ?? "Worker error" }, { status: workerRes.status });
    }

    return NextResponse.json({ status: "queued" });
  } catch (e) {
    console.error("Unhandled error in /api/jobs/brief:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
