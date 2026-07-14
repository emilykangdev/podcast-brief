import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signEstimate, verifyEstimate } from "@/libs/estimate-signer.js";

// signEstimate/verifyEstimate read STRIPE_SECRET_KEY lazily on every call (getSecret()),
// so tests can freely swap it between cases without needing a shared setup.
describe("estimate-signer", () => {
  const ORIGINAL_ENV = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture_only_not_a_real_key";
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = ORIGINAL_ENV;
  });

  it("round-trips a valid signature", () => {
    const sig = signEstimate("https://podcasts.apple.com/episode/1", 3600);
    expect(verifyEstimate("https://podcasts.apple.com/episode/1", 3600, sig)).toBe(true);
  });

  it("rejects a tampered durationSeconds", () => {
    const sig = signEstimate("https://podcasts.apple.com/episode/1", 3600);
    // Attacker changes durationSeconds from 3600 (1 credit) to 1 (still 1 credit,
    // but for a 4-hour episode this is the exact underpayment attack the HMAC exists to stop)
    expect(verifyEstimate("https://podcasts.apple.com/episode/1", 1, sig)).toBe(false);
  });

  it("rejects signature reuse across a different episodeUrl", () => {
    const sig = signEstimate("https://podcasts.apple.com/episode/1", 3600);
    expect(verifyEstimate("https://podcasts.apple.com/episode/2", 3600, sig)).toBe(false);
  });

  it("short-circuits on length mismatch instead of throwing on timingSafeEqual", () => {
    const sig = signEstimate("https://podcasts.apple.com/episode/1", 3600);
    expect(() => verifyEstimate("https://podcasts.apple.com/episode/1", 3600, sig.slice(0, -2))).not.toThrow();
    expect(verifyEstimate("https://podcasts.apple.com/episode/1", 3600, sig.slice(0, -2))).toBe(false);
  });

  it("returns false (not throw) when sig is missing or empty", () => {
    expect(verifyEstimate("https://podcasts.apple.com/episode/1", 3600, "")).toBe(false);
    expect(verifyEstimate("https://podcasts.apple.com/episode/1", 3600, undefined)).toBe(false);
  });

  it("throws when STRIPE_SECRET_KEY is not set", () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(() => signEstimate("https://podcasts.apple.com/episode/1", 3600)).toThrow(
      "STRIPE_SECRET_KEY is required for estimate signing"
    );
  });
});
