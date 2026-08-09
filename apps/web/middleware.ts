import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Only the marketing/health surface is public. Every research-console route
 * requires an authenticated, organisation-scoped Clerk session — ARF-OS has
 * no anonymous read access (spec 17: organisation-scoped, append-only
 * research governance).
 */
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    // Explicit signInUrl: without it, protect() has no in-app destination
    // for a signed-out visitor and falls back to rewriting to a bare 404.
    await auth.protect({ unauthenticatedUrl: new URL("/sign-in", request.url).toString() });
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
