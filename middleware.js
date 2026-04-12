import arcjet, { shield } from "@arcjet/next";
import { updateSession } from "@/libs/supabase/middleware";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [shield({ mode: "LIVE" })],
});

export async function middleware(request) {
  // Shield: fail open — if Arcjet is unreachable, let the request through
  // rather than taking down the entire site
  try {
    const decision = await aj.protect(request);
    if (decision.isDenied()) {
      return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
  } catch (e) {
    console.error("[arcjet] shield error, failing open:", e.message);
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
