"use client";

import { AppShell, PublicShell, useLockedOut } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { ExploreDiscover } from "@/components/explore-discover";
import { TermsGate } from "@/components/terms-gate";
import { Spinner } from "@/components/ui";
import { useAccount } from "@/lib/queries";

/** The site's front page, and public: a visitor sees what Explore does; having the AI find documents, and adding
 * one to a library, needs an account. Signed in, it is one of the app's pages, inside the app's bar and dock. */
export default function ExplorePage() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return session ? <SignedInExplore key={session.user.id} /> : <PublicExplore />;
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
  return (
    <PublicShell mainClassName="">
      <Explore signedIn={false} className="mx-auto max-w-[1200px] px-4 pb-[calc(72px+env(safe-area-inset-bottom))] pt-8 sm:px-10 sm:pt-10" />
    </PublicShell>
  );
}

function Explore({ signedIn, className }: { signedIn: boolean; className: string }) {
  return (
    <div className={className}>
      <ExploreDiscover signedIn={signedIn} />
    </div>
  );
}
