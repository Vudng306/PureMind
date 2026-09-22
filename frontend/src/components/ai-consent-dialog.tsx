"use client";

import { useT } from "@/lib/i18n";
import { MSG } from "@/lib/messages";
import { useAiConsent } from "@/lib/summary";

import { ConfirmDialog } from "./ui";

/** NFR-PRV: asked once, before the first AI request sends the user's content to OpenAI. */
export function AiConsentDialog({
  open,
  what,
  onAgreed,
  onCancel,
}: {
  open: boolean;
  /** What will be sent, e.g. the text of this document — already in the reader's language. */
  what: string;
  onAgreed: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const consent = useAiConsent();

  async function agree() {
    try {
      await consent.mutateAsync();
    } catch {
      return; // the error is shown in the dialog
    }
    onAgreed();
  }

  return (
    <ConfirmDialog
      open={open}
      title={t("consent.titleShort")}
      tone="primary"
      confirmLabel={t("consent.confirm")}
      cancelLabel={t("consent.decline")}
      busy={consent.isPending}
      onConfirm={() => void agree()}
      onCancel={onCancel}
    >
      <p>{t("consent.bodyWhat", { what })}</p>
      <p className="mt-2 text-sm text-muted">{t("consent.onceOnly")}</p>
      {consent.isError && <p className="mt-2 text-sm text-danger">{MSG["MSG-23"]}</p>}
    </ConfirmDialog>
  );
}
