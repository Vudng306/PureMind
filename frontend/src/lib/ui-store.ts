"use client";

import { create } from "zustand";

interface UiState {
  addOpen: boolean;
  paletteOpen: boolean;
  toast: { id: number; text: string } | null;
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
  setAddOpen: (addOpen) => set({ addOpen, paletteOpen: false }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  showToast: (text) => set({ toast: { id: Date.now(), text } }),
  hideToast: () => set({ toast: null }),
}));
