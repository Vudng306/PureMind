"use client";

/** Where to sign in, coming back to `next` afterwards. */
export function signInHref(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

/** Where to go after signing in, if it is a page of this site: never another site's address. */
export function safeNext(next: string | null): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}
