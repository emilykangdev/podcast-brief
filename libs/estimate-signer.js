import "server-only";
import crypto from "crypto";

// Server-only module — do NOT import from client components ("use client").
// Signs and verifies estimate data so the confirm endpoint can detect tampering.

function getSecret() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("STRIPE_SECRET_KEY is required for estimate signing");
  return secret;
}

export function signEstimate(episodeUrl, durationSeconds) {
  return crypto.createHmac("sha256", getSecret()).update(`${episodeUrl}|${durationSeconds}`).digest("hex");
}

export function verifyEstimate(episodeUrl, durationSeconds, sig) {
  if (!sig) return false;
  const expected = signEstimate(episodeUrl, durationSeconds);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}
