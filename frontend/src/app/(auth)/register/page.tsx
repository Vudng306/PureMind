"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { AuthTabs, GoogleSignIn } from "@/components/auth-parts";
import { SupabaseConfigNotice } from "@/components/config-notice";
import { Icon } from "@/components/icons";
import { TermsChoices } from "@/components/terms-choices";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { authErrorMessage, isAlreadyRegistered } from "@/lib/auth-errors";
import { useT } from "@/lib/i18n";
import { EMAIL_RE, MSG, PASSWORD_RE } from "@/lib/messages";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { TERMS_VERSION } from "@/lib/terms";

export default function RegisterPage() {
  const t = useT();
  const router = useRouter();
  const { session, loading } = useAuth();
  const [form, setForm] = useState({ displayName: "", email: "", password: "", confirm: "" });
  const [terms, setTerms] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace("/explore");
  }, [loading, session, router]);

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const email = form.email.trim().toLowerCase();
    const displayName = form.displayName.trim();
    // FR-AUTH-01 step 1: validate before calling Supabase
    if (!displayName || displayName.length > 255) return setError(MSG["MSG-07"]);
    if (!EMAIL_RE.test(email) || email.length > 255) return setError(MSG["MSG-01"]);
    if (!PASSWORD_RE.test(form.password)) return setError(MSG["MSG-02"]);
    if (form.password !== form.confirm) return setError(t("auth.confirmMismatch"));
    if (!terms) return setError(t("terms.required"));

    setBusy(true);
    try {
      const { data, error: authError } = await supabase().auth.signUp({
        email,
        password: form.password,
        options: {
          // The profile is made on the first API request, maybe after the e-mail is confirmed: the
          // choices go with the account so the server records them then (api/deps.py).
          data: { display_name: displayName, terms_version: TERMS_VERSION, ai_consent: aiConsent },
          // This also makes confirmation work outside localhost when Supabase email
          // confirmation is enabled.
          emailRedirectTo: `${window.location.origin}/explore`,
        },
      });
      if (authError) return setError(authErrorMessage(authError));
      if (isAlreadyRegistered(data.user)) return setError(MSG["MSG-03"]);
      if (!data.session) {
        // Supabase returns no session when "Confirm email" is enabled; an unconfirmed email is sent the link again.
        setSentTo(email);
        return;
      }
      await api("/account").catch(() => undefined); // FR-AUTH-01 step 4: provision profile
      router.replace("/explore");
    } catch (err) {
      setError(authErrorMessage(err instanceof Error ? err : new Error()));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-[18px]">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-soft text-accent">
          <Icon name="mail" size={26} />
        </span>
        <h2 className="font-serif text-4xl font-medium">{t("auth.checkInbox")}</h2>
        <p className="text-base leading-relaxed text-body">{t("auth.confirmSent", { email: sentTo })}</p>
        <Link href="/login" className="btn-primary h-[50px] text-base">
          {t("auth.toSignIn")}
        </Link>
      </div>
    );
  }

  return (
    <>
      <h2 className="font-display text-[40px] font-semibold leading-tight tracking-[-0.02em]">{t("auth.createAccount")}</h2>
      <AuthTabs active="register" />
      {!isSupabaseConfigured && <SupabaseConfigNotice />}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <label className="field-label">
          {t("auth.name")}
          <input
            className="input"
            autoComplete="name"
            value={form.displayName}
            onChange={update("displayName")}
            maxLength={255}
            required
          />
        </label>
        <label className="field-label">
          {t("auth.email")}
          <input
            className="input"
            type="email"
            autoComplete="email"
            placeholder={t("auth.emailPlaceholder")}
            value={form.email}
            onChange={update("email")}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field-label">
            {t("auth.password")}
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={t("auth.passwordMin")}
              value={form.password}
              onChange={update("password")}
              minLength={8}
              maxLength={72}
            />
          </label>
          <label className="field-label">
            {t("auth.repeatPassword")}
            <input className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={update("confirm")} />
          </label>
        </div>
        <TermsChoices terms={terms} ai={aiConsent} onTerms={setTerms} onAi={setAiConsent} />
        {error && <Alert>{error}</Alert>}
        <button className="btn-primary h-[50px] text-base" disabled={busy || !isSupabaseConfigured}>
          {t(busy ? "auth.signingUp" : "auth.signUp")}
        </button>
      </form>
      <GoogleSignIn onError={setError} />
    </>
  );
}
