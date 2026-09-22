"use client";

import Link from "next/link";
import { useState } from "react";

import { authErrorMessage } from "@/lib/auth-errors";
import { useT } from "@/lib/i18n";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export function AuthTabs({ active }: { active: "login" | "register" }) {
  const t = useT();
  return (
    <nav className="flex gap-2" aria-label={t("auth.tabsAria")}>
      <Link href="/login" className="chip" aria-current={active === "login" ? "page" : undefined} aria-pressed={active === "login"}>
        {t("auth.signIn")}
      </Link>
      <Link
        href="/register"
        className="chip"
        aria-current={active === "register" ? "page" : undefined}
        aria-pressed={active === "register"}
      >
        {t("auth.signUp")}
      </Link>
    </nav>
  );
}

/** An "or" divider + Google sign-in (Supabase OAuth; the provider must be enabled in the Supabase project). */
export function GoogleSignIn({ onError }: { onError: (message: string) => void }) {
  const t = useT();
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
        {t("auth.or")}
        <span className="h-px flex-1 bg-line" />
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={busy || !isSupabaseConfigured}
        className="btn h-[50px] border border-field bg-surface text-base hover:bg-soft"
      >
        <span className="font-bold text-accent">G</span>
        {t(busy ? "auth.googleRedirect" : "auth.google")}
      </button>
    </>
  );
}
