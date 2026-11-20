"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { keyboardInset } from "@/lib/mobile";
import { usePreferences } from "@/lib/preferences";
import { THEME_COLOR } from "@/lib/theme-color";
import { useUi } from "@/lib/ui-store";

import { AuthProvider } from "./auth-provider";
import { Toast } from "./ui";

function ThemeApplier() {
  const theme = usePreferences((s) => s.theme);
  // The reader's own page (light, sepia, dark) is over the app's theme while a document is open.
  const pageTheme = useUi((s) => s.pageTheme);
  useEffect(() => {
    const shown = pageTheme ?? theme;
    document.documentElement.dataset.theme = shown;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[shown]);
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

/** Keeps --keyboard-inset up to date, so what sits at the bottom of a phone's screen stays above the keyboard. */
function KeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const inset = keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop, viewport.scale);
      document.documentElement.style.setProperty("--keyboard-inset", `${inset}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
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
        <KeyboardInset />
        {children}
        <Toast />
      </AuthProvider>
    </QueryClientProvider>
  );
}
