"use client";

import Link from "next/link";

import { LanguageToggle } from "@/components/language-toggle";
import { useT } from "@/lib/i18n";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="app-backdrop grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between gap-10 px-[72px] py-14 lg:flex">
        <span className="font-serif font-semibold text-[28px]">PureMind</span>
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
          className="card w-[450px] max-w-full px-8 py-7 font-serif text-[17px] leading-relaxed text-body shadow-float"
        >
          <div className="mb-2.5 font-sans text-xs tracking-[0.08em] text-muted">{t("auth.sampleEyebrow")}</div>
          {t("auth.sampleBefore")}
          <span className="bg-[#F5DC8C] text-[#3E382F]">{t("auth.sampleHighlight")}</span>
          {t("auth.sampleAfter")}
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="card flex w-full max-w-[460px] flex-col gap-[22px] p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <span className="font-serif font-semibold text-[28px] lg:hidden">PureMind</span>
            <span className="flex-1" />
            <LanguageToggle />
          </div>
          {children}
          <Link href="/terms" className="self-center text-[13px] text-muted underline-offset-2 hover:underline">
            {t("terms.footer")}
          </Link>
        </div>
      </section>
    </main>
  );
}
