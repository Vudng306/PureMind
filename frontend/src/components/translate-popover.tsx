"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useCompact } from "@/lib/mobile";
import { useSaveTranslation } from "@/lib/notes";
import { useAccount } from "@/lib/queries";
import { cachedTranslation, looksVietnamese, translateText } from "@/lib/translate";
import { useUi } from "@/lib/ui-store";

import { AiConsentDialog } from "./ai-consent-dialog";
import { BottomSheet } from "./bottom-sheet";
import { AiBadge } from "./cite";
import { Icon } from "./icons";
import { selectionMenuBounds } from "./selection-menu";

const CARD_W = 440;
const CARD_MAX_H = 360;
// The reader opens this on every finished selection; a selection still being stretched with Shift+arrow
// replaces it before the wait is over, so only the last one is sent.
const SETTLE_MS = 350;

/** The translation of a selected passage, in a card next to where it was selected. It is marked as the AI's,
 * the passage stays as it is in the document, and it is kept as a note only when the reader asks (AN-107). */
export function TranslatePopover({
  docId,
  text,
  rect,
  onClose,
}: {
  docId: string;
  text: string;
  /** Where the passage was on screen when it was selected. */
  rect: DOMRect;
  onClose: () => void;
}) {
  const t = useT();
  const showToast = useUi((s) => s.showToast);
  const { data: user } = useAccount();
  const ref = useRef<HTMLDivElement>(null);
  const [translation, setTranslation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  // Which way it goes, as the server decides it; known for sure once the translation is done.
  const [target, setTarget] = useState<"vi" | "en">(() => (looksVietnamese(text) ? "en" : "vi"));
  const [savedId, setSavedId] = useState<string | null>(null);
  const save = useSaveTranslation(docId);
  const compact = useCompact();
  // Booleans, not `user`: a refetched account must not start another translation.
  const loaded = Boolean(user);
  const consented = Boolean(user?.reading_preferences.ai_consent);

  const run = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError(null);
      setTranslation("");
      try {
        const result = await translateText(text, (d) => setTranslation((s) => s + d), signal);
        setTranslation(result.translation);
        if (result.target === "vi" || result.target === "en") setTarget(result.target);
      } catch (e) {
        if (signal?.aborted) return;
        setError(e instanceof ApiError ? e.message : MSG["MSG-99"]);
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [text],
  );

  // Translate as soon as it opens — once the user has agreed to send content to OpenAI (NFR-PRV).
  useEffect(() => {
    if (!loaded) return;
    if (!consented) return setAsking(true);
    const controller = new AbortController();
    const wait = cachedTranslation(text) ? 0 : SETTLE_MS;
    const timer = setTimeout(() => void run(controller.signal), wait);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loaded, consented, run, text]);

  useEffect(() => {
    if (asking || compact) return; // the consent dialog and the sheet handle their own clicks and keys
    function onDown(e: MouseEvent | TouchEvent) {
      const target = e.target as Element;
      // The selection menu stays usable next to the card: highlighting the passage keeps its translation.
      if (ref.current?.contains(target) || target.closest?.("[data-selection-menu]")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [asking, compact, onClose]);

  function keep() {
    if (savedId || save.isPending || !translation) return;
    save.mutate(
      { quote: text, translation, target },
      {
        onSuccess: (note) => {
          setSavedId(note.id);
          showToast(t("translate.savedToast"));
        },
        onError: (e) => showToast(e instanceof ApiError ? e.message : t("ai.saveFailed")),
      },
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(translation);
      showToast(t("translate.copied"));
    } catch {
      showToast(t("reader.copyFailed"));
    }
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_W, vw - 24);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), vw - width - 12);
  // Clear of the passage and of the selection menu next to it: below them when there is room, otherwise
  // above them (held by its bottom edge, so a short translation stays close), otherwise pinned to the bottom.
  const menu = selectionMenuBounds(rect);
  const upper = Math.min(rect.top, menu.top);
  const lower = Math.max(rect.bottom, menu.bottom);
  const place =
    lower + 10 + CARD_MAX_H < vh
      ? { top: lower + 10 }
      : upper - 10 - CARD_MAX_H > 12
        ? { bottom: vh - upper + 10 }
        : { top: Math.max(12, vh - CARD_MAX_H - 12) };

  const action = "h-8 px-3 text-[13px] max-md:h-11 max-md:px-4";
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Icon name="translate" size={16} className="text-accent-text" />
        <span className="flex-1 text-[13px] font-semibold text-ink">
          {t(target === "en" ? "translate.titleViEn" : "translate.title")}
        </span>
        <AiBadge />
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="icon-btn h-8 w-8 text-muted max-md:hidden">
          <Icon name="x" size={15} />
        </button>
      </div>
      <p className="line-clamp-2 border-l-[3px] border-line pl-2.5 text-[13px] italic text-muted">{text}</p>
      <div className="min-h-[44px] overflow-y-auto" aria-live="polite" aria-busy={busy}>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : translation ? (
          <p className="whitespace-pre-wrap font-serif text-[16px] leading-relaxed text-ink">{translation}</p>
        ) : (
          <p className="text-sm text-muted">{t("translate.working")}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        {error ? (
          <button type="button" className={`btn-outline ${action}`} onClick={() => void run()}>
            {t("common.retry")}
          </button>
        ) : (
          <>
            <button type="button" className={`btn-ghost ${action}`} onClick={() => void copy()} disabled={busy || !translation}>
              <Icon name="copy" size={14} />
              {t("selection.copyShort")}
            </button>
            <button
              type="button"
              className={`btn-ghost ${action} ${savedId ? "text-success" : ""}`}
              onClick={keep}
              disabled={busy || !translation || save.isPending || savedId !== null}
            >
              <Icon name={savedId ? "check" : "bookmark"} size={14} />
              {t(savedId ? "translate.saved" : "translate.save")}
            </button>
          </>
        )}
      </div>
    </>
  );

  return (
    <>
      {!asking &&
        (compact ? (
          <BottomSheet open onClose={onClose} label={t("translate.title")}>
            <div className="flex flex-col gap-2.5 px-1 font-sans">{body}</div>
          </BottomSheet>
        ) : (
          <div
            ref={ref}
            role="dialog"
            aria-label={t("translate.title")}
            className="fixed z-30 flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-3.5 font-sans shadow-[0_12px_30px_rgba(0,0,0,0.22)]"
            style={{ left, width, maxHeight: CARD_MAX_H, ...place }}
          >
            {body}
          </div>
        ))}
      <AiConsentDialog
        open={asking}
        what={t("translate.consentWhat")}
        onAgreed={() => setAsking(false)}
        onCancel={onClose}
      />
    </>
  );
}
