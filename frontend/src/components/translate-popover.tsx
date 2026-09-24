"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { translateText } from "@/lib/translate";
import { useUi } from "@/lib/ui-store";

import { AiConsentDialog } from "./ai-consent-dialog";
import { Icon } from "./icons";

const CARD_W = 440;
const CARD_MAX_H = 360;

/** The translation of a selected passage, in a card next to where it was selected. */
export function TranslatePopover({
  text,
  rect,
  onClose,
}: {
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
    void run(controller.signal);
    return () => controller.abort();
  }, [loaded, consented, run]);

  useEffect(() => {
    if (asking) return; // the consent dialog handles its own clicks and keys
    function onDown(e: MouseEvent | TouchEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
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
  }, [asking, onClose]);

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
  // Below the passage when there is room, otherwise above it, otherwise pinned to the bottom.
  const top =
    rect.bottom + 10 + CARD_MAX_H < vh
      ? rect.bottom + 10
      : rect.top - 10 - CARD_MAX_H > 12
        ? rect.top - 10 - CARD_MAX_H
        : Math.max(12, vh - CARD_MAX_H - 12);

  return (
    <>
      {!asking && (
        <div
          ref={ref}
          role="dialog"
          aria-label={t("translate.title")}
          className="fixed z-30 flex flex-col gap-2.5 rounded-[14px] border border-line bg-surface p-3.5 font-sans shadow-[0_12px_30px_rgba(0,0,0,0.22)]"
          style={{ left, top, width, maxHeight: CARD_MAX_H }}
        >
          <div className="flex items-center gap-2">
            <Icon name="translate" size={16} className="text-accent" />
            <span className="flex-1 text-[13px] font-semibold text-ink">{t("translate.title")}</span>
            <button type="button" aria-label={t("common.close")} onClick={onClose} className="icon-btn h-8 w-8 text-muted">
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
              <button type="button" className="btn-outline h-8 px-3 text-[13px]" onClick={() => void run()}>
                {t("common.retry")}
              </button>
            ) : (
              <button
                type="button"
                className="btn-ghost h-8 px-3 text-[13px]"
                onClick={() => void copy()}
                disabled={busy || !translation}
              >
                <Icon name="copy" size={14} />
                {t("selection.copyShort")}
              </button>
            )}
          </div>
        </div>
      )}
      <AiConsentDialog
        open={asking}
        what={t("translate.consentWhat")}
        onAgreed={() => setAsking(false)}
        onCancel={onClose}
      />
    </>
  );
}
