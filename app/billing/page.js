import { createClient } from "@/libs/supabase/server";
import BillingClient from "./BillingClient";

export const dynamic = "force-dynamic";

function parseReason(reason) {
  if (reason === "signup_bonus") return { type: "signup_bonus" };
  if (reason.startsWith("refund:")) return { type: "refund", label: reason.split(":").slice(1).join(":") };
  if (reason.startsWith("purchase:")) return { type: "purchase", label: reason.split(":").slice(1).join(":") };
  if (reason.startsWith("brief:")) return { type: "brief", briefId: reason.split(":").slice(1).join(":") };
  if (reason.startsWith("regen:")) return { type: "regen", briefId: reason.split(":").slice(1).join(":") };
  return { type: "unknown", label: reason };
}

export default async function BillingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", user.id)
    .single();

  const { data: ledger } = await supabase
    .from("credit_ledger")
    .select("*")
    .eq("profile_id", user.id)
    .eq("environment", process.env.APP_ENV)
    .order("created_at", { ascending: false });

  // Extract brief IDs from reason strings to fetch episode titles
  const briefIds = (ledger ?? [])
    .map((r) => parseReason(r.reason))
    .filter((p) => p.briefId)
    .map((p) => p.briefId);

  let briefMap = {};
  if (briefIds.length > 0) {
    const { data: briefs } = await supabase
      .from("briefs")
      .select("id, episode_title, podcast_name, episode_duration_seconds")
      .in("id", briefIds);

    for (const b of briefs ?? []) {
      briefMap[b.id] = {
        episode_title: b.episode_title,
        podcast_name: b.podcast_name,
        episode_duration_seconds: b.episode_duration_seconds,
      };
    }
  }

  const entries = (ledger ?? []).map((row) => {
    const parsed = parseReason(row.reason);
    const brief = parsed.briefId ? briefMap[parsed.briefId] : null;
    return {
      id: row.id,
      date: row.created_at,
      delta: row.delta_credits,
      balance: row.credits_left ?? 0,
      type: parsed.type,
      label: parsed.label,
      episodeTitle: brief?.episode_title,
      podcastName: brief?.podcast_name,
      durationSeconds: brief?.episode_duration_seconds,
    };
  });

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-4xl mx-auto space-y-8">
        <h1 className="text-3xl font-extrabold">Billing</h1>
        <BillingClient entries={entries} credits={profile?.credits ?? 0} />
      </section>
    </main>
  );
}
