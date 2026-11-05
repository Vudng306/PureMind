"use client";

import { useRouter } from "next/navigation";

import { Icon } from "@/components/icons";
import { LanguageToggle } from "@/components/language-toggle";
import { useLang, useT } from "@/lib/i18n";
import { TERMS } from "@/lib/terms";

/** The terms of use and privacy policy, readable without an account (linked from sign-up). */
export default function TermsPage() {
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const terms = TERMS[lang];

  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-4 py-10 sm:py-14">
      <div className="flex items-center justify-between gap-3">
        <button type="button" className="btn-ghost h-10 px-3" onClick={() => (history.length > 1 ? router.back() : router.push("/"))}>
          <Icon name="back" />
          {t("terms.back")}
        </button>
        <LanguageToggle />
      </div>
      <header className="flex flex-col gap-3">
        <span className="font-display text-[23px] font-semibold">PureMind</span>
        <h1 className="font-display text-[36px] font-semibold leading-tight tracking-[-0.01em] sm:text-[44px]">{t("terms.title")}</h1>
        <p className="text-sm text-muted">{terms.updated}</p>
        <p className="text-[16px] leading-relaxed text-body">{terms.intro}</p>
      </header>
      {terms.sections.map((section) => (
        <section key={section.title} className="flex flex-col gap-3">
          <h2 className="font-serif text-[24px] font-medium">{section.title}</h2>
          {section.body.map((block, i) =>
            typeof block === "string" ? (
              <p key={i} className="text-[16px] leading-relaxed text-body">
                {block}
              </p>
            ) : (
              <ul key={i} className="flex list-disc flex-col gap-1.5 pl-5 text-[16px] leading-relaxed text-body">
                {block.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ),
          )}
        </section>
      ))}
    </main>
  );
}
