"use client";

import Link from "next/link";
import { Suspense } from "react";

import { AppShell, MainNav, PUBLIC_NAV, useLockedOut } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { LanguageToggle } from "@/components/language-toggle";
import { SharedLibrary } from "@/components/shared-library";
import { TermsGate } from "@/components/terms-gate";
import { Logo, Spinner } from "@/components/ui";
import { useT } from "@/lib/i18n";
import { useAccount } from "@/lib/queries";

/** The site's front page, and public: a visitor browses the open articles; adding one to a library needs an account.
 * Signed in, it is one of the app's pages, inside the app's bar and dock. */
export default function ExplorePage() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return session ? <SignedInExplore /> : <PublicExplore />;
}

/** It is outside the app's pages, so what they ask of an account is asked here too. */
function SignedInExplore() {
  const { data: user } = useAccount();
  useLockedOut();

  if (user && !user.terms_accepted) return <TermsGate user={user} />;
  return (
    <AppShell>
      <Explore signedIn className="mx-auto max-w-[1200px]" />
    </AppShell>
  );
}

function PublicExplore() {
  const t = useT();

  return (
    <div className="app-backdrop min-h-screen">
      <header className="glass sticky top-0 z-20 border-b">
        <div className="flex h-[68px] items-center gap-3 px-4 sm:gap-4 sm:px-10 xl:gap-6">
          <Logo word="hidden min-[400px]:inline" />
          <MainNav items={PUBLIC_NAV} className="hidden sm:flex" />
          <span className="flex-1" />
          <LanguageToggle />
          <Link href="/login" className="btn-primary h-11 px-4">
            {t("explore.signIn")}
          </Link>
        </div>
      </header>

      <main>
        <Explore signedIn={false} className="mx-auto max-w-[1200px] px-4 pb-[72px] pt-8 sm:px-10 sm:pt-10" />
      </main>
    </div>
  );
}

function Explore({ signedIn, className }: { signedIn: boolean; className: string }) {
  return (
    <div className={className}>
      <Suspense fallback={<Spinner />}>
        <SharedLibrary signedIn={signedIn} />
      </Suspense>
    </div>
  );
}
