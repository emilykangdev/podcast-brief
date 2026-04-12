import { createClient } from "@/libs/supabase/server";
import { getPostHog } from "@/libs/posthog/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code");
  const supabase = await createClient();

  if (code) {
    // exchangeCodeForSession sets the auth cookie and returns the user — no need for a
    // separate getUser() call. Saves one round trip to Supabase (~500ms).
    const { data: { user } } = await supabase.auth.exchangeCodeForSession(code);

    if (user) {
      const { data } = await supabase.from("briefs").select("id").eq("profile_id", user.id).limit(1);
      if (data?.length === 0) {
        // Track sign-up for new users — use created_at to avoid double-counting
        // returning users who haven't generated a brief yet
        const createdAt = new Date(user.created_at);
        const isNewUser = Date.now() - createdAt.getTime() < 60_000; // created within last 60s
        if (isNewUser) {
          const posthog = getPostHog();
          posthog?.capture({
            distinctId: user.id,
            event: "sign_up",
            properties: { email: user.email },
            uuid: `sign_up:${user.id}`,
          });
          await posthog?.flush();
        }
        return NextResponse.redirect(new URL("/onboarding", requestUrl.origin));
      }
    }
  }

  // Fallback: no code or exchange failed → /dashboard, which bounces to /signin via layout guard
  return NextResponse.redirect(new URL("/dashboard", requestUrl.origin));
}
