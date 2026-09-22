"use client";

import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between gap-10 border-r border-line bg-soft px-[72px] py-14 lg:flex">
        <span className="font-serif text-[28px] font-semibold">PureMind</span>
        <div className="flex flex-col gap-6">
          <h1 className="font-serif text-[64px] font-medium leading-[1.04]">
            {t("auth.heroLine1")}
            <br />
            {t("auth.heroLine2")}
          </h1>
          <p className="max-w-[470px] text-lg leading-relaxed text-body">{t("auth.heroBody")}</p>
        </div>
        <div
          aria-hidden
          className="w-[450px] max-w-full rounded border border-line bg-surface px-8 py-7 font-serif text-[17px] leading-relaxed text-body shadow-float"
        >
          <div className="mb-2.5 font-sans text-xs tracking-[0.08em] text-muted">{t("auth.sampleEyebrow")}</div>
          {t("auth.sampleBefore")}
          <span className="bg-[#F5DC8C] text-[#3E382F]">{t("auth.sampleHighlight")}</span>
          {t("auth.sampleAfter")}
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="flex w-full max-w-[420px] flex-col gap-[22px]">
          <div className="flex items-center justify-between">
            <span className="font-serif text-[28px] font-semibold lg:hidden">PureMind</span>
            <span className="flex-1" />
            <LanguageToggle />
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
