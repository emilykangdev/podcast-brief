import { createClient } from "@/libs/supabase/server";
import ButtonAccount from "@/components/ButtonAccount";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: briefs } = await supabase
    .from("briefs")
    .select("id, input_url, output_markdown, status, podcast_name, episode_title, created_at, completed_at, regeneration_count, error_log, credits_charged")
    .eq("profile_id", user.id)
    .eq("environment", process.env.APP_ENV || "DEVELOPMENT")
    .order("created_at", { ascending: false });

  const { data: profile } = await supabase
    .from("profiles")
    .select("credits")
    .eq("id", user.id)
    .single();

  return (
    <main className="min-h-screen p-8 pb-24">
      <section className="max-w-4xl mx-auto space-y-8">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-extrabold">Your Briefs</h1>
          <ButtonAccount />
        </div>
        <DashboardClient briefs={briefs ?? []} credits={profile?.credits ?? 0} />
      </section>
    </main>
  );
}
