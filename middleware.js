import arcjet, { shield } from "@arcjet/next";
import { updateSession } from "@/libs/supabase/middleware";

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [shield({ mode: "LIVE" })],
});

export async function middleware(request) {
  // Middleware shield covers page routes plus the Stripe webhook. Most API
  // routes are excluded so they can run a single per-route Arcjet decision.
  const decision = await aj.protect(request);
  if (decision.isErrored()) {
    console.error("[arcjet] shield error, failing open:", decision.reason.message);
  } else if (decision.isDenied()) {
    return new Response(
      JSON.stringify({ error: "Forbidden" }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/ (API routes protect themselves, except the Stripe webhook below)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    "/api/webhook/stripe",
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
