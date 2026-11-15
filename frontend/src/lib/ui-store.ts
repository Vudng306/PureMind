"use client";

import { create } from "zustand";

import type { Theme } from "./types";

interface UiState {
  addOpen: boolean;
  paletteOpen: boolean;
  toast: { id: number; text: string } | null;
  /** The page of the open reader (RD-105), which goes over the theme of the app while it is open. */
  pageTheme: Theme | null;
  setPageTheme: (pageTheme: Theme | null) => void;
  setAddOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  showToast: (text: string) => void;
  hideToast: () => void;
}

/** App-wide overlays: add-document dialog, Ctrl+K palette and toast. */
export const useUi = create<UiState>()((set) => ({
  addOpen: false,
  paletteOpen: false,
  toast: null,
  pageTheme: null,
  setPageTheme: (pageTheme) => set({ pageTheme }),
  setAddOpen: (addOpen) => set({ addOpen, paletteOpen: false }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  showToast: (text) => set({ toast: { id: Date.now(), text } }),
  hideToast: () => set({ toast: null }),
}));
