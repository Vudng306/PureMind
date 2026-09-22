"use client";

import { useEffect, useRef } from "react";

import { api } from "@/lib/api";
import { usePreferences } from "@/lib/preferences";
import { useAccount } from "@/lib/queries";
import type { ReadingPreferences } from "@/lib/types";

type Local = ReturnType<typeof usePreferences.getState>;

/** Same key order on both sides so the JSON strings can be compared. */
const serverShape = (p: ReadingPreferences) =>
  JSON.stringify({
    theme: p.theme,
    font_size: p.font_size,
    line_height: p.line_height,
    column_width: p.column_width,
    default_mode: p.default_mode,
    language: p.language,
    color_labels: p.color_labels && {
      yellow: p.color_labels.yellow,
      green: p.color_labels.green,
      blue: p.color_labels.blue,
      pink: p.color_labels.pink,
      purple: p.color_labels.purple ?? "",
    },
  });

const localShape = (
  p: Pick<Local, "theme" | "fontSize" | "lineHeight" | "width" | "defaultMode" | "language" | "colorLabels">,
) =>
  serverShape({
    theme: p.theme,
    font_size: p.fontSize,
    line_height: p.lineHeight,
    column_width: p.width,
    default_mode: p.defaultMode,
    language: p.language,
    color_labels: p.colorLabels,
  });

/**
 * FR-ACC-04: adopt server preferences once, then push local changes (debounced 1 s, non-blocking).
 * Options the server does not have yet are uploaded from this device.
 */
export function PreferencesSync() {
  const { data: user } = useAccount();
  const { theme, fontSize, lineHeight, width, defaultMode, language, colorLabels, applyServer } = usePreferences();
  const adopted = useRef(false);
  const lastSent = useRef<string>("");

  useEffect(() => {
    if (!user || adopted.current) return;
    adopted.current = true;
    applyServer(user.reading_preferences);
    lastSent.current = serverShape(user.reading_preferences);
  }, [user, applyServer]);

  const payload = localShape({ theme, fontSize, lineHeight, width, defaultMode, language, colorLabels });

  // The <html lang> tells the browser how to hyphenate and how a screen reader should pronounce it.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (!adopted.current || payload === lastSent.current) return;
    const t = setTimeout(() => {
      lastSent.current = payload;
      api("/account", {
        method: "PATCH",
        body: JSON.stringify({ reading_preferences: JSON.parse(payload) }),
      }).catch(() => undefined); // sync errors never block the UI
    }, 1000);
    return () => clearTimeout(t);
  }, [payload, user]);

  return null;
}
