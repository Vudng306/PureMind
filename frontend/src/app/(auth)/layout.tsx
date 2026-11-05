"use client";

import Link from "next/link";

import { LanguageToggle } from "@/components/language-toggle";
import { Logo } from "@/components/ui";
import { useT } from "@/lib/i18n";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <main className="app-backdrop grid min-h-screen lg:grid-cols-2">
      <section className="relative m-3 hidden flex-col justify-between gap-10 overflow-hidden rounded-[28px] bg-ink px-[60px] py-12 text-bg lg:flex">
        <span aria-hidden className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-accent" />
        <span aria-hidden className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-accent/25" />
        <Logo href="/" className="relative" />
        <div className="relative flex flex-col gap-6">
          <h1 className="font-display text-[64px] font-semibold leading-[1.02] tracking-[-0.02em]">
            {t("auth.heroLine1")}
            <br />
            {t("auth.heroLine2")}
          </h1>
          <p className="max-w-[470px] text-lg leading-relaxed text-bg/75">{t("auth.heroBody")}</p>
        </div>
        <div
          aria-hidden
          className="card relative w-[450px] max-w-full px-8 py-7 font-serif text-[17px] leading-relaxed text-body shadow-float"
        >
          <div className="eyebrow mb-2.5 font-sans">{t("auth.sampleEyebrow")}</div>
          {t("auth.sampleBefore")}
          <span className="bg-[#F5DC8C] text-[#3E382F]">{t("auth.sampleHighlight")}</span>
          {t("auth.sampleAfter")}
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-12">
        <div className="card flex w-full max-w-[460px] flex-col gap-[22px] p-6 sm:p-8">
          <div className="flex items-center justify-between">
            <Logo href="/" className="lg:hidden" />
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
