import supabase from "@/libs/supabase/admin.mjs";
import { randomUUID } from "crypto";

export const TEST_ENV = process.env.APP_ENV || "DEVELOPMENT";

// handle_new_user() grants 3 free credits and a signup_bonus ledger row on insert —
// pass `credits` to reset to a specific starting balance for a test case.
export async function createTestProfile({ credits } = {}) {
  const email = `test-${randomUUID()}@example.com`;
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error) throw error;
  const profileId = data.user.id;

  if (credits !== undefined) {
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ credits })
      .eq("id", profileId);
    if (updateError) throw updateError;
  }

  return profileId;
}

export async function deleteTestProfile(profileId) {
  // Cascades to profiles/briefs/credit_ledger via FK ON DELETE CASCADE.
  await supabase.auth.admin.deleteUser(profileId).catch(() => {});
}

export async function getProfile(profileId) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", profileId).single();
  if (error) throw error;
  return data;
}

export async function insertCompletedBrief({ profileId, creditsCharged, completedAt, inputUrl }) {
  const { data, error } = await supabase
    .from("briefs")
    .insert({
      profile_id: profileId,
      input_url: inputUrl ?? `https://podcasts.apple.com/episode/${randomUUID()}`,
      status: "complete",
      output_markdown: "# Test brief\n",
      credits_charged: creditsCharged,
      completed_at: completedAt,
      regeneration_count: 0,
      environment: TEST_ENV,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function insertQueuedBrief({ profileId, inputUrl, createdAt, environment = TEST_ENV }) {
  const { data, error } = await supabase
    .from("briefs")
    .insert({
      profile_id: profileId,
      input_url: inputUrl ?? `https://podcasts.apple.com/episode/${randomUUID()}`,
      status: "queued",
      created_at: createdAt,
      environment,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function insertGeneratingBrief({ profileId, inputUrl, startedAt, environment = TEST_ENV }) {
  const { data, error } = await supabase
    .from("briefs")
    .insert({
      profile_id: profileId,
      input_url: inputUrl ?? `https://podcasts.apple.com/episode/${randomUUID()}`,
      status: "generating",
      started_at: startedAt,
      environment,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

export async function getBrief(briefId) {
  const { data, error } = await supabase.from("briefs").select("*").eq("id", briefId).single();
  if (error) throw error;
  return data;
}
