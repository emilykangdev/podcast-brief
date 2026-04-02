import { createClient } from "@/libs/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code");
  const supabase = await createClient();

  if (code) {
    // exchangeCodeForSession sets the auth cookie. If a session already exists, it overwrites it.
    await supabase.auth.exchangeCodeForSession(code);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Use select+limit(1) instead of count — simpler, avoids full COUNT(*) scan.
    // If query fails, data is null and we fall through to /dashboard (acceptable default).
    const { data } = await supabase.from("briefs").select("id").eq("profile_id", user.id).limit(1);

    if (data?.length === 0) {
      return NextResponse.redirect(new URL("/onboarding", requestUrl.origin));
    }
  }

  // Fallback: no user (bad/missing code) → /dashboard, which bounces to /signin via layout guard
  return NextResponse.redirect(new URL("/dashboard", requestUrl.origin));
}
