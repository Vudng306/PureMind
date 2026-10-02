"use client";

import { useState } from "react";

import { GoogleSignIn } from "@/components/auth-parts";
import { SupabaseConfigNotice } from "@/components/config-notice";
import { LanguageToggle } from "@/components/language-toggle";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { useT } from "@/lib/i18n";
import { EMAIL_RE, MSG } from "@/lib/messages";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

/** A centred card with the admin's wordmark, shared by the sign-in form and the "not an admin" notice. */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card flex w-full max-w-[420px] flex-col gap-[22px] p-7 shadow-float sm:p-8">
        <div className="flex items-center justify-between">
          <span className="flex items-baseline gap-2">
            <span className="font-serif text-[26px] font-semibold">PureMind</span>
            <span className="eyebrow">{t("admin.title").toUpperCase()}</span>
          </span>
          <LanguageToggle />
        </div>
        {children}
      </div>
    </main>
  );
}

/**
 * FR-ADM: the admin pages' own sign-in. It is the same Supabase account as in the app; whether it may see
 * the admin pages is decided by its role once signed in, so there is no sign-up and no separate password.
 */
export function AdminLogin({ initialError = null }: { initialError?: string | null }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!EMAIL_RE.test(email.trim())) return setError(MSG["MSG-01"]);
    if (!password) return setError(MSG["MSG-04"]);

    setBusy(true);
    try {
      const { error: authError } = await supabase().auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (authError) return setError(authErrorMessage(authError));
      // Provision the profile on a first sign-in; the layout then shows the admin pages or says why not.
      await api("/account").catch(() => undefined);
    } catch (err) {
      setError(authErrorMessage(err instanceof Error ? err : new Error()));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminGate>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-serif text-[32px] font-medium leading-tight">{t("admin.loginTitle")}</h1>
        <p className="text-sm text-muted">{t("admin.loginSubtitle")}</p>
      </div>
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
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <button className="btn-primary h-[50px] text-base" disabled={busy || !isSupabaseConfigured}>
          {t(busy ? "auth.signingIn" : "auth.signIn")}
        </button>
      </form>
      <GoogleSignIn onError={setError} redirectPath="/admin/users" />
    </AdminGate>
  );
}
