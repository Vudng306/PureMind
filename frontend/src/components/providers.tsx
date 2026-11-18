"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { usePreferences } from "@/lib/preferences";
import { useUi } from "@/lib/ui-store";

import { AuthProvider } from "./auth-provider";
import { useVisualViewport } from "./mobile-surfaces";
import { Toast } from "./ui";

function ThemeApplier() {
  const theme = usePreferences((s) => s.theme);
  // The reader's own page (light, sepia, dark) is over the app's theme while a document is open.
  const pageTheme = useUi((s) => s.pageTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = pageTheme ?? theme;
  }, [theme, pageTheme]);
  return null;
}

/** The <html lang> tells the browser how to hyphenate and a screen reader how to pronounce the page. */
function LangApplier() {
  const language = usePreferences((s) => s.language);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  useVisualViewport();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeApplier />
        <LangApplier />
        {children}
        <Toast />
      </AuthProvider>
    </QueryClientProvider>
  );
}
