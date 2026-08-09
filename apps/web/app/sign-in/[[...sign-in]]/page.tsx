import { SignIn } from "@clerk/nextjs";

/**
 * Catch-all so Clerk can own its multi-step flows (factor two, SSO
 * callback) under this path. Without a real sign-in route, `auth.protect()`
 * has nowhere to send a signed-out visitor and falls back to a bare 404.
 */
export default function SignInPage() {
  return (
    <main>
      <SignIn />
    </main>
  );
}
