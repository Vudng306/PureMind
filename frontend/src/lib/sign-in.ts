"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

/** A visitor reads Explore and the feed without an account; keeping anything (the library, notebooks, what they
 * follow, where they stopped) or talking (the community, the AI) is what asks them to sign in. */
export function signInHref(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

/** Where to go after signing in, if it is a page of this site: never another site's address. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

/** Sends the visitor to sign in, and back to the page they were on afterwards. */
export function useSignIn() {
  const router = useRouter();
  return useCallback(() => router.push(signInHref(window.location.pathname + window.location.search)), [router]);
}
