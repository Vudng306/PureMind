"use client";

import Link from "next/link";
import { useState } from "react";

import { authErrorMessage } from "@/lib/auth-errors";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export function AuthTabs({ active }: { active: "login" | "register" }) {
  return (
    <nav className="flex gap-2" aria-label="Đăng nhập hoặc đăng ký">
      <Link href="/login" className="chip" aria-current={active === "login" ? "page" : undefined} aria-pressed={active === "login"}>
        Đăng nhập
      </Link>
      <Link
        href="/register"
        className="chip"
        aria-current={active === "register" ? "page" : undefined}
        aria-pressed={active === "register"}
      >
        Đăng ký
      </Link>
    </nav>
  );
}

/** "hoặc" divider + Google sign-in (Supabase OAuth; the provider must be enabled in the Supabase project). */
export function GoogleSignIn({ onError }: { onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    const { error } = await supabase().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/library` },
    });
    if (error) {
      setBusy(false);
      onError(authErrorMessage(error));
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 text-[13px] text-muted">
        <span className="h-px flex-1 bg-line" />
        hoặc
        <span className="h-px flex-1 bg-line" />
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={busy || !isSupabaseConfigured}
        className="btn h-[50px] border border-field bg-surface text-base hover:bg-soft"
      >
        <span className="font-bold text-accent">G</span>
        {busy ? "Đang chuyển tới Google…" : "Tiếp tục với Google"}
      </button>
    </>
  );
}
