"use client";

import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState } from "react";

import { isSupabaseConfigured, supabase } from "@/lib/supabase";

interface AuthState {
  session: Session | null;
  loading: boolean;
}

const AuthContext = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, loading: isSupabaseConfigured });
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    const auth = supabase().auth;
    let active = true;
    auth
      .getSession()
      .then(({ data }) => {
        if (active) setState({ session: data.session, loading: false });
      })
      // A browser extension, a blocked storage API, or a transient network problem must not
      // leave the application on a permanent loading screen.
      .catch(() => {
        if (active) setState({ session: null, loading: false });
      });
    const { data } = auth.onAuthStateChange((event, session) => {
      setState({ session, loading: false });
      if (event === "SIGNED_OUT") queryClient.clear(); // FR-AUTH-04 step 2
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
