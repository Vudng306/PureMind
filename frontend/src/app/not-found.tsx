"use client";

import Link from "next/link";

import { useT } from "@/lib/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <main className="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <p className="eyebrow mb-3">404</p>
        <h1 className="mb-3 font-display text-3xl font-semibold text-ink">{t("notFound.title")}</h1>
        <p className="mb-7 text-muted">{t("notFound.body")}</p>
        <Link href="/" className="btn-primary">{t("notFound.home")}</Link>
      </div>
    </main>
  );
}
