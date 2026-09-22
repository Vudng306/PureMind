"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { AuthTabs, GoogleSignIn } from "@/components/auth-parts";
import { SupabaseConfigNotice } from "@/components/config-notice";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { useT } from "@/lib/i18n";
import { EMAIL_RE, MSG } from "@/lib/messages";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

function LoginForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const { session, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("expired") ? MSG["MSG-06"] : null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace("/library");
  }, [loading, session, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!EMAIL_RE.test(email.trim())) return setError(MSG["MSG-01"]);
    if (!password) return setError(MSG["MSG-04"]);

    setBusy(true);
    const { error: authError } = await supabase().auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (authError) {
      setBusy(false);
      return setError(authErrorMessage(authError));
    }
    await api("/account").catch(() => undefined); // FR-AUTH-02 step 3: load / provision profile
    router.replace("/library");
  }

  async function forgot() {
    setError(null);
    setInfo(null);
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value)) return setError(t("auth.enterEmailFirst"));
    const { error: authError } = await supabase().auth.resetPasswordForEmail(value, {
      redirectTo: `${window.location.origin}/settings`,
    });
    if (authError) return setError(authErrorMessage(authError));
    setInfo(t("auth.resetSent", { email: value }));
  }

  return (
    <>
      <h2 className="font-serif text-[40px] font-medium leading-tight">{t("auth.welcomeBack")}</h2>
      <AuthTabs active="login" />
      {!isSupabaseConfigured && <SupabaseConfigNotice />}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <label className="field-label">
          {t("auth.email")}
          <input
            className="input"
            type="email"
            autoComplete="email"
            placeholder={t("auth.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field-label">
          {t("auth.password")}
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            placeholder={t("auth.passwordMin")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <Alert>{error}</Alert>}
        {info && <Alert tone="success">{info}</Alert>}
        <button className="btn-primary h-[50px] text-base" disabled={busy || !isSupabaseConfigured}>
          {t(busy ? "auth.signingIn" : "auth.signIn")}
        </button>
      </form>
      <GoogleSignIn onError={setError} />
      <button
        type="button"
        onClick={forgot}
        disabled={!isSupabaseConfigured}
        className="self-start py-2 text-sm font-medium text-accent hover:underline disabled:opacity-50"
      >
        {t("auth.forgot")}
      </button>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
