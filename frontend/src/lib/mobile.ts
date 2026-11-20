import { useEffect, useRef, useSyncExternalStore } from "react";

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** A phone-sized window: below Tailwind's `md`, where the reader takes its one-handed layout. */
export const useCompact = () => useMedia("(max-width: 767.98px)");

/** A finger rather than a mouse: no Enter-to-send habit, no keyboard shortcuts to mention. */
export const useCoarsePointer = () => useMedia("(pointer: coarse)");

const SELECTION_SETTLE_MS = 120;

/** On a touch screen a selection is made and stretched with the system's handles, which send the page no touch
 * events, so it is followed through the document's `selectionchange` instead. */
export function useSelectionTracking<T>(enabled: boolean, read: () => T | null, onSelect: (selection: T | null) => void) {
  const latest = useRef({ read, onSelect });
  latest.current = { read, onSelect };
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => latest.current.onSelect(latest.current.read()), SELECTION_SETTLE_MS);
    };
    document.addEventListener("selectionchange", changed);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", changed);
    };
  }, [enabled]);
}

export type BarsState = { shown: boolean; anchor: number };

/** How far the text must travel one way (px) before the reader's bars change, and how near an end they always show. */
const BAR_TURN = 24;
const BAR_EDGE = 16;

/** The reader's bars step aside while reading on and come back on the way up and at either end of the text.
 * `anchor` is the furthest point reached in the present direction, so a slow scroll counts as much as a fast one. */
export function followScroll(bars: BarsState, top: number, max: number): BarsState {
  if (top <= BAR_EDGE || top >= max - BAR_EDGE) return { shown: true, anchor: top };
  const moved = top - bars.anchor;
  if (bars.shown ? moved > BAR_TURN : moved < -BAR_TURN) return { shown: !bars.shown, anchor: top };
  return { shown: bars.shown, anchor: bars.shown ? Math.min(bars.anchor, top) : Math.max(bars.anchor, top) };
}

/** How far a sheet must be dragged (px), or how fast flicked (px/ms), to move to the next stop. */
const DRAG_DISTANCE = 72;
const FLICK_SPEED = 0.5;

/** Where a bottom sheet goes when the finger lifts: one stop per gesture, and closed below the lowest stop.
 * `stops` run from lowest to highest; `dragged` is positive downwards. */
export function settleSheet<T extends string>(stops: readonly T[], from: T, dragged: number, ms: number): T | "closed" {
  const speed = ms > 0 ? dragged / ms : 0;
  const down = dragged > DRAG_DISTANCE || (dragged > 0 && speed > FLICK_SPEED);
  const up = dragged < -DRAG_DISTANCE || (dragged < 0 && speed < -FLICK_SPEED);
  const at = Math.max(0, stops.indexOf(from));
  if (down) return at === 0 ? "closed" : stops[at - 1];
  if (up) return stops[Math.min(at + 1, stops.length - 1)];
  return stops[at];
}

/** Below this the gap under the visual viewport is browser chrome, not a keyboard. */
const MIN_KEYBOARD = 80;

/** How much of the layout viewport the on-screen keyboard covers. A pinch-zoomed page also shrinks the visual
 * viewport, and that is not a keyboard. */
export function keyboardInset(layoutHeight: number, visualHeight: number, offsetTop: number, scale = 1): number {
  if (scale > 1.01) return 0;
  const inset = Math.round(layoutHeight - visualHeight - offsetTop);
  return inset >= MIN_KEYBOARD ? inset : 0;
}

/** Where a scroller goes on one axis when its content changes size, so that `point` (a distance into the content
 * at the size `from`) ends up `at` pixels from the scroller's edge. */
export function scrollAfterZoom(point: number, from: number, to: number, at: number): number {
  return Math.max(0, (point * to) / from - at);
}
