"use client";

import Link from "next/link";

import { useT } from "@/lib/i18n";

/**
 * The two choices asked on sign-up and on the welcome screen: the terms of use (required) and, apart from
 * them, sending content to OpenAI (optional, never ticked for the user: NFR-PRV-01).
 */
export function TermsChoices({
  terms,
  ai,
  onTerms,
  onAi,
}: {
  terms: boolean;
  ai: boolean;
  onTerms: (value: boolean) => void;
  onAi: (value: boolean) => void;
}) {
  const t = useT();
  const box = "mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]";
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      <label className="flex cursor-pointer gap-3">
        <input type="checkbox" className={box} checked={terms} onChange={(e) => onTerms(e.target.checked)} />
        <span className="text-body">
          {t("terms.acceptPre")}
          <Link href="/terms" target="_blank" className="font-medium text-accent-text underline underline-offset-2">
            {t("terms.acceptLink")}
          </Link>
          {t("terms.acceptPost")}
        </span>
      </label>
      <label className="flex cursor-pointer gap-3">
        <input type="checkbox" className={box} checked={ai} onChange={(e) => onAi(e.target.checked)} />
        <span className="flex flex-col gap-1">
          <span className="text-body">{t("terms.aiLabel")}</span>
          <span className="text-[13px] text-muted">{t("terms.aiHint")}</span>
        </span>
      </label>
    </div>
  );
}
