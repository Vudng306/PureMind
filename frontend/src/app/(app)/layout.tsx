"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { AppOverlays, AppShell, useLockedOut } from "@/components/app-shell";
import { useAuth } from "@/components/auth-provider";
import { TermsGate } from "@/components/terms-gate";
import { Spinner } from "@/components/ui";
import { useAccount } from "@/lib/queries";
import { isSupabaseConfigured } from "@/lib/supabase";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { session, loading } = useAuth();
  const { data: user } = useAccount();
  useLockedOut();

  // FR-AUTH-05 step 4
  useEffect(() => {
    if (!isSupabaseConfigured || (!loading && !session)) router.replace("/login");
  }, [loading, session, router]);

  if (!isSupabaseConfigured || loading || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
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
