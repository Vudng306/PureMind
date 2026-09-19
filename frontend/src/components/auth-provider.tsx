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
    auth.getSession().then(({ data }) => setState({ session: data.session, loading: false }));
    const { data } = auth.onAuthStateChange((event, session) => {
      setState({ session, loading: false });
      if (event === "SIGNED_OUT") queryClient.clear(); // FR-AUTH-04 step 2
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
