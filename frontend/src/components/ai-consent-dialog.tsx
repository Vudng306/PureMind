"use client";

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
  /** What will be sent, e.g. "nội dung văn bản của tài liệu này". */
  what: string;
  onAgreed: () => void;
  onCancel: () => void;
}) {
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
      title="Gửi nội dung tới OpenAI?"
      tone="primary"
      confirmLabel="Đồng ý và tạo"
      cancelLabel="Để sau"
      busy={consent.isPending}
      onConfirm={() => void agree()}
      onCancel={onCancel}
    >
      <p>
        Để dùng tính năng này, PureMind sẽ gửi {what} tới dịch vụ OpenAI. Nội dung chỉ được gửi khi bạn chủ động yêu cầu
        một tính năng AI.
      </p>
      <p className="mt-2 text-sm text-muted">Bạn chỉ cần đồng ý một lần.</p>
      {consent.isError && <p className="mt-2 text-sm text-danger">{MSG["MSG-23"]}</p>}
    </ConfirmDialog>
  );
}
