import { NextResponse } from "next/server";
import { createClient } from "@/libs/supabase/server";

export async function POST(req) {
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Proxy to Railway worker — WORKER_SECRET never sent to browser
  const workerRes = await fetch(`${process.env.WORKER_URL}/jobs/brief`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WORKER_SECRET}`,
    },
    body: JSON.stringify({ episodeUrl, profileId: user.id }),
  });

  if (!workerRes.ok) {
    const err = await workerRes.json().catch(() => ({}));
    return NextResponse.json({ error: err.error ?? "Worker error" }, { status: workerRes.status });
  }

  return NextResponse.json({ status: "queued" });
}
