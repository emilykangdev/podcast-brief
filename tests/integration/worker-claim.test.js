import { describe, it, expect, afterEach } from "vitest";
import {
  claimNextJob,
  recoverStaleJobs,
  STALE_JOB_TIMEOUT_MS,
  __setCurrentJobIdForTesting,
} from "@/server.mjs";
import {
  TEST_ENV,
  createTestProfile,
  deleteTestProfile,
  insertQueuedBrief,
  insertGeneratingBrief,
  getBrief,
} from "./helpers/factories.js";

// Covers server.mjs's atomic job claim (the `UPDATE ... WHERE status='queued'` race guard)
// and stale-job recovery, against a real local Postgres.

const createdProfiles = [];
afterEach(async () => {
  await Promise.all(createdProfiles.splice(0).map(deleteTestProfile));
  __setCurrentJobIdForTesting(null);
});

describe("claimNextJob", () => {
  it("claims the oldest queued job and flips it to generating", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    const older = await insertQueuedBrief({
      profileId,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await insertQueuedBrief({ profileId, createdAt: new Date().toISOString() });

    const claimed = await claimNextJob();

    expect(claimed.id).toBe(older);
    const brief = await getBrief(older);
    expect(brief.status).toBe("generating");
    expect(brief.started_at).not.toBeNull();
  });

  it("two workers racing the same single queued job: exactly one claims it", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    const briefId = await insertQueuedBrief({ profileId });

    const [a, b] = await Promise.all([claimNextJob(), claimNextJob()]);
    const claims = [a, b].filter(Boolean);

    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe(briefId);

    const brief = await getBrief(briefId);
    expect(brief.status).toBe("generating");
  });

  it("ignores queued jobs from a different environment", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    await insertQueuedBrief({ profileId, environment: "PRODUCTION" });
    expect(TEST_ENV).not.toBe("PRODUCTION");

    const claimed = await claimNextJob();

    expect(claimed).toBeNull();
  });

  it("returns null when there is no queued work", async () => {
    const claimed = await claimNextJob();
    expect(claimed).toBeNull();
  });
});

describe("recoverStaleJobs", () => {
  it("resets a generating job older than the stale threshold back to queued", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    const staleStartedAt = new Date(Date.now() - STALE_JOB_TIMEOUT_MS - 60_000).toISOString();
    const briefId = await insertGeneratingBrief({ profileId, startedAt: staleStartedAt });

    await recoverStaleJobs();

    const brief = await getBrief(briefId);
    expect(brief.status).toBe("queued");
    expect(brief.started_at).toBeNull();
  });

  it("leaves a fresh (non-stale) generating job untouched", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    const freshStartedAt = new Date(Date.now() - 60_000).toISOString(); // well under 20min
    const briefId = await insertGeneratingBrief({ profileId, startedAt: freshStartedAt });

    await recoverStaleJobs();

    const brief = await getBrief(briefId);
    expect(brief.status).toBe("generating");
  });

  it("excludes the recovering worker's own in-flight job even if it looks stale", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    const staleStartedAt = new Date(Date.now() - STALE_JOB_TIMEOUT_MS - 60_000).toISOString();
    const briefId = await insertGeneratingBrief({ profileId, startedAt: staleStartedAt });
    __setCurrentJobIdForTesting(briefId); // simulates this worker still actively running it

    await recoverStaleJobs();

    const brief = await getBrief(briefId);
    expect(brief.status).toBe("generating"); // not reset out from under the in-flight pipeline
  });

  it("does not touch stale generating jobs from a different environment", async () => {
    const profileId = await createTestProfile();
    createdProfiles.push(profileId);
    const staleStartedAt = new Date(Date.now() - STALE_JOB_TIMEOUT_MS - 60_000).toISOString();
    const briefId = await insertGeneratingBrief({
      profileId,
      startedAt: staleStartedAt,
      environment: "PRODUCTION",
    });
    expect(TEST_ENV).not.toBe("PRODUCTION");

    await recoverStaleJobs();

    const brief = await getBrief(briefId);
    expect(brief.status).toBe("generating");
  });
});
