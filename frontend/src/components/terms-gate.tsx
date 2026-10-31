"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { supabase } from "@/lib/supabase";
import { useAcceptTerms } from "@/lib/terms";
import type { User } from "@/lib/types";

import { LanguageToggle } from "./language-toggle";
import { TermsChoices } from "./terms-choices";
import { Alert } from "./ui";

/**
 * Shown instead of the app until the user accepts the current terms of use: accounts made with Google,
 * accounts made before the terms existed, and everyone again when the terms change.
 */
export function TermsGate({ user }: { user: User }) {
  const t = useT();
  const router = useRouter();
  const accept = useAcceptTerms();
  const [terms, setTerms] = useState(false);
  // An earlier "yes" from the AI dialog stays the user's choice; nobody else starts ticked.
  const [ai, setAi] = useState(Boolean(user.reading_preferences.ai_consent));
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!terms) return setError(t("terms.required"));
    setError(null);
    accept.mutate(ai, { onError: () => setError(MSG["MSG-99"]) });
  }

  async function signOut() {
    await supabase()
      .auth.signOut()
      .catch(() => supabase().auth.signOut({ scope: "local" }));
    router.replace("/login");
  }

  return (
    <main className="app-backdrop flex min-h-screen items-center justify-center px-4 py-12">
      <form onSubmit={submit} className="card flex w-full max-w-[520px] flex-col gap-5 p-6 sm:p-8" noValidate>
        <div className="flex items-center justify-between">
          <span className="font-serif text-[24px] font-semibold">PureMind</span>
          <LanguageToggle />
        </div>
        <h1 className="font-serif text-[32px] font-medium leading-tight">{t("terms.gateTitle")}</h1>
        <p className="text-[15px] leading-relaxed text-body">{t("terms.gateBody")}</p>
        <TermsChoices terms={terms} ai={ai} onTerms={setTerms} onAi={setAi} />
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary h-[46px] px-6" disabled={accept.isPending}>
            {t(accept.isPending ? "terms.gateSaving" : "terms.gateContinue")}
          </button>
          <button type="button" className="btn-ghost h-[46px] text-muted" onClick={signOut}>
            {t("settings.signOut")}
          </button>
        </div>
      </form>
    </main>
  );
}
