import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import supabase from "@/libs/supabase/admin.mjs";
import {
  TEST_ENV,
  createTestProfile,
  deleteTestProfile,
  getProfile,
  insertCompletedBrief,
} from "./helpers/factories.js";
import { holdRowLock, assertStillPending } from "./helpers/pg-lock.js";

// Money-path coverage for the atomic credit RPCs (supabase/migrations/20260408000000_stripe_credits.sql),
// run against a real local Postgres (via `supabase start`) — not mocked. These RPCs are the
// only place credits move; a bug here means double-charging or double-crediting real users.

const createdProfiles = [];
afterEach(async () => {
  await Promise.all(createdProfiles.splice(0).map(deleteTestProfile));
});

async function queueBrief(profileId, { episodeUrl, durationSeconds = 3600, creditsToCharge = 1 } = {}) {
  return supabase.rpc("consume_credits_and_queue_brief", {
    p_profile_id: profileId,
    p_episode_url: episodeUrl ?? `https://podcasts.apple.com/episode/${randomUUID()}`,
    p_duration_seconds: durationSeconds,
    p_credits_to_charge: creditsToCharge,
    p_environment: TEST_ENV,
  });
}

describe("consume_credits_and_queue_brief", () => {
  it("deducts credits and queues a brief on a clean submission", async () => {
    const profileId = await createTestProfile({ credits: 5 });
    createdProfiles.push(profileId);

    const { data, error } = await queueBrief(profileId, { creditsToCharge: 2 });

    expect(error).toBeNull();
    expect(data.error).toBeUndefined();
    expect(data.credits_charged).toBe(2);
    expect(data.credits_remaining).toBe(3);

    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(3);
  });

  it("succeeds at the exact credit boundary (credits == cost)", async () => {
    const profileId = await createTestProfile({ credits: 2 });
    createdProfiles.push(profileId);

    const { data, error } = await queueBrief(profileId, { creditsToCharge: 2 });

    expect(error).toBeNull();
    expect(data.credits_remaining).toBe(0);
  });

  it("rejects cleanly one credit short of the boundary, with no partial state", async () => {
    const profileId = await createTestProfile({ credits: 1 });
    createdProfiles.push(profileId);

    const { data, error } = await queueBrief(profileId, { creditsToCharge: 2 });

    expect(error).toBeNull();
    expect(data.error).toBe("insufficient_credits");
    expect(data.credits_remaining).toBe(1);

    // No brief inserted, no credits touched.
    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(1);
    const { data: briefs } = await supabase.from("briefs").select("id").eq("profile_id", profileId);
    expect(briefs).toHaveLength(0);
  });

  it("concurrent double-submission of the SAME episode: exactly one queued, one loses to the unique index", async () => {
    const profileId = await createTestProfile({ credits: 10 });
    createdProfiles.push(profileId);
    const episodeUrl = `https://podcasts.apple.com/episode/${randomUUID()}`;

    // Force the interleaving deterministically instead of hoping Promise.all happens to
    // overlap: hold the same profiles row lock the RPC itself takes (SELECT ... FOR UPDATE),
    // fire both calls, and confirm both are genuinely blocked on it. Since the RPC's dedup
    // SELECT runs *before* that lock (unlocked), both calls reaching "blocked on the lock"
    // proves both already ran their dedup check and found nothing — the exact race window
    // the partial unique index exists to guard.
    const lock = await holdRowLock("profiles", "id", profileId);
    const promiseA = queueBrief(profileId, { episodeUrl, creditsToCharge: 2 });
    const promiseB = queueBrief(profileId, { episodeUrl, creditsToCharge: 2 });
    try {
      await assertStillPending(Promise.allSettled([promiseA, promiseB]));
    } finally {
      await lock.release();
    }

    const [a, b] = await Promise.all([promiseA, promiseB]);

    // One of the two either got a graceful `already_exists` (lost the soft dedup check)
    // or hit the partial unique index as a raw 23505 (lost the hard race guard) — the
    // route.js caller (app/api/jobs/brief/route.js) explicitly handles both. Exactly one
    // of the two calls must be a real winner.
    const results = [a, b];
    const winners = results.filter((r) => !r.error && !r.data?.error);
    const losers = results.filter((r) => r.error || r.data?.error);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (loser.error) {
      expect(loser.error.code).toBe("23505");
    } else {
      expect(loser.data.error).toBe("already_exists");
    }

    // Credits charged exactly once, not twice.
    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(8);

    const { data: briefs } = await supabase
      .from("briefs")
      .select("id")
      .eq("profile_id", profileId)
      .eq("input_url", episodeUrl);
    expect(briefs).toHaveLength(1);
  });

  it("concurrent submissions of DIFFERENT episodes racing the same credit balance: only what fits succeeds", async () => {
    // 3 credits available, two concurrent 2-credit submissions for different episodes —
    // only one can fit. The row-level lock (SELECT ... FOR UPDATE on profiles) must
    // serialize these so credits never go negative and exactly one succeeds.
    const profileId = await createTestProfile({ credits: 3 });
    createdProfiles.push(profileId);

    // Same deterministic-interleaving technique as the same-episode race above: hold the
    // profiles lock, confirm both calls are genuinely queued on it, then release.
    const lock = await holdRowLock("profiles", "id", profileId);
    const promiseA = queueBrief(profileId, { creditsToCharge: 2 });
    const promiseB = queueBrief(profileId, { creditsToCharge: 2 });
    try {
      await assertStillPending(Promise.allSettled([promiseA, promiseB]));
    } finally {
      await lock.release();
    }

    const [a, b] = await Promise.all([promiseA, promiseB]);

    const results = [a, b].map((r) => r.data);
    const winners = results.filter((d) => !d.error);
    const losers = results.filter((d) => d.error === "insufficient_credits");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(1); // 3 - 2, never negative
    expect(profile.credits).toBeGreaterThanOrEqual(0);
  });
});

describe("consume_credits_and_regenerate_brief", () => {
  async function regenerate(profileId, briefId, creditsToCharge) {
    return supabase.rpc("consume_credits_and_regenerate_brief", {
      p_profile_id: profileId,
      p_brief_id: briefId,
      p_credits_to_charge: creditsToCharge,
      p_environment: TEST_ENV,
    });
  }

  it("free regen within 24h resets the brief without touching credits", async () => {
    const profileId = await createTestProfile({ credits: 5 });
    createdProfiles.push(profileId);
    const briefId = await insertCompletedBrief({
      profileId,
      creditsCharged: 2,
      completedAt: new Date().toISOString(),
    });

    const { data, error } = await regenerate(profileId, briefId, 0);

    expect(error).toBeNull();
    expect(data.error).toBeUndefined();
    expect(data.credits_charged).toBe(0);

    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(5); // untouched

    const { data: brief } = await supabase.from("briefs").select("status, regeneration_count").eq("id", briefId).single();
    expect(brief.status).toBe("queued");
    expect(brief.regeneration_count).toBe(1);
  });

  it("paid regen after 24h deducts credits", async () => {
    const profileId = await createTestProfile({ credits: 5 });
    createdProfiles.push(profileId);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const briefId = await insertCompletedBrief({ profileId, creditsCharged: 2, completedAt: twoDaysAgo });

    const { data, error } = await regenerate(profileId, briefId, 2);

    expect(error).toBeNull();
    expect(data.credits_charged).toBe(2);
    expect(data.credits_remaining).toBe(3);

    const profile = await getProfile(profileId);
    expect(profile.credits).toBe(3);
  });

  it("insufficient credits on a paid regen leaves the brief untouched", async () => {
    const profileId = await createTestProfile({ credits: 1 });
    createdProfiles.push(profileId);
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const briefId = await insertCompletedBrief({ profileId, creditsCharged: 2, completedAt: twoDaysAgo });

    const { data, error } = await regenerate(profileId, briefId, 2);

    expect(error).toBeNull();
    expect(data.error).toBe("insufficient_credits");

    const { data: brief } = await supabase.from("briefs").select("status, regeneration_count").eq("id", briefId).single();
    expect(brief.status).toBe("complete"); // untouched
    expect(brief.regeneration_count).toBe(0);
  });

  it("concurrent regen race on the same brief: exactly one wins, one gets already_regenerated", async () => {
    const profileId = await createTestProfile({ credits: 10 });
    createdProfiles.push(profileId);
    const briefId = await insertCompletedBrief({
      profileId,
      creditsCharged: 2,
      completedAt: new Date().toISOString(),
    });

    // consume_credits_and_regenerate_brief also takes FOR UPDATE on the profiles row before
    // its atomic UPDATE ... WHERE regeneration_count = 0 — same deterministic-interleaving
    // technique as the queue_brief races above.
    const lock = await holdRowLock("profiles", "id", profileId);
    const promiseA = regenerate(profileId, briefId, 0);
    const promiseB = regenerate(profileId, briefId, 0);
    try {
      await assertStillPending(Promise.allSettled([promiseA, promiseB]));
    } finally {
      await lock.release();
    }

    const [a, b] = await Promise.all([promiseA, promiseB]);

    const results = [a.data, b.data];
    const winners = results.filter((d) => !d.error);
    const losers = results.filter((d) => d.error === "already_regenerated");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const { data: brief } = await supabase.from("briefs").select("regeneration_count").eq("id", briefId).single();
    expect(brief.regeneration_count).toBe(1); // not double-incremented
  });
});
