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
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
