import { createClient } from "@/libs/supabase/server";
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
        return NextResponse.redirect(new URL("/onboarding", requestUrl.origin));
      }
    }
  }

  // Fallback: no code or exchange failed → /dashboard, which bounces to /signin via layout guard
  return NextResponse.redirect(new URL("/dashboard", requestUrl.origin));
}
