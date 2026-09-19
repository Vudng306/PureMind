"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { apiFetch } from "@/lib/api";
import type { User } from "@/lib/types";

/** Avatars are served only through the authenticated API, so they are fetched as blobs. */
export function Avatar({ user, size = 36 }: { user: User; size?: number }) {
  const { data: blob } = useQuery({
    queryKey: ["avatar", user.avatar_url],
    queryFn: async () => (await apiFetch(user.avatar_url!.replace(/^\/api/, ""))).blob(),
    enabled: Boolean(user.avatar_url),
    staleTime: Infinity,
  });
  const src = useMemo(() => (blob ? URL.createObjectURL(blob) : null), [blob]);
  useEffect(() => () => (src ? URL.revokeObjectURL(src) : undefined), [src]);

  const initial = (user.display_name || user.email).trim().charAt(0).toUpperCase();
  const style = { width: size, height: size };
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" style={style} className="shrink-0 rounded-full object-cover" />;
  }
  return (
    <span
      style={{ ...style, fontSize: size * 0.42 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-ink font-serif text-bg"
      aria-hidden
    >
      {initial}
    </span>
  );
}
