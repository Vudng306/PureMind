"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { AppOverlays, AppShell, useLockedOut } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { TermsGate } from "@/components/terms-gate";
import { Spinner } from "@/components/ui";
import { useAccount } from "@/lib/queries";
import { signInHref } from "@/lib/sign-in";
import { isSupabaseConfigured } from "@/lib/supabase";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { session, loading } = useAuth();
  const { data: user } = useAccount();
  useLockedOut();

  // FR-AUTH-05 step 4, and back here once signed in.
  useEffect(() => {
    if (session || (loading && isSupabaseConfigured)) return;
    router.replace(signInHref(window.location.pathname + window.location.search));
  }, [loading, session, router]);

  if (!session || (loading && isSupabaseConfigured)) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // The terms come first: nothing of the app until the current version is accepted.
  if (user && !user.terms_accepted) return <TermsGate user={user} />;

  // The reader uses the full screen.
  if (pathname.startsWith("/reader/")) {
    return (
      <>
        <AppOverlays />
        {children}
      </>
    );
  }

  return <AppShell>{children}</AppShell>;
}
