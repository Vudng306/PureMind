"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useSaveUrl, useUploadDocument } from "@/lib/documents";
import { MAX_UPLOAD_BYTES, MSG, messageFor } from "@/lib/messages";
import { useUi } from "@/lib/ui-store";

import { Icon } from "./icons";
import { Alert, useModal } from "./ui";

type Tab = "file" | "link";

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** UI-03 upload / save-link dialog (FR-DOC-01, FR-DOC-03). */
export function AddDocumentDialog() {
  const router = useRouter();
  const { addOpen: open, setAddOpen, showToast } = useUi();
  const ref = useModal(open);
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<Tab>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const upload = useUploadDocument();
  const saveUrl = useSaveUrl();
  const busy = upload.isPending || saveUrl.isPending;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setUrl("");
    setFile(null);
  }, [open]);

  const onClose = () => setAddOpen(false);

  function done(docId: string, status: string, code: string | null) {
    if (status === "failed") {
      setError(messageFor(code));
      return;
    }
    onClose();
    router.push(`/reader/${docId}`);
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    setError(null);
    const name = picked.name.toLowerCase();
    // FR-DOC-01 step 1: client-side pre-check
    if (!name.endsWith(".pdf") && !name.endsWith(".epub")) return setError(MSG["MSG-10"]);
    if (picked.size > MAX_UPLOAD_BYTES) return setError(MSG["MSG-11"]);
    setFile(picked);
  }

  async function submitFile() {
    if (!file) return fileInput.current?.click();
    setError(null);
    try {
      const doc = await upload.mutateAsync(file);
      // A failed extraction still keeps the document; PDFs can be read as the original.
      if (doc.extraction_status === "failed" && doc.file_type === "pdf") {
        onClose();
        router.push(`/reader/${doc.id}`);
        return;
      }
      if (doc.extraction_status === "pending" || doc.extraction_status === "processing") {
        onClose();
        showToast("Đã tải lên. Văn bản sạch đang được trích xuất…");
        return;
      }
      done(doc.id, doc.extraction_status, doc.extraction_error);
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-12"]);
    }
  }

  async function submitLink(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    const value = url.trim();
    if (!/^https?:\/\/\S+$/i.test(value) || value.length > 2048) return setError(MSG["MSG-16"]);
    try {
      const doc = await saveUrl.mutateAsync(value);
      done(doc.id, doc.extraction_status, doc.extraction_error);
    } catch (err) {
      setError(err instanceof Error ? err.message : MSG["MSG-18"]);
    }
  }

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      className="dialog"
      aria-labelledby="add-doc-title"
    >
      <div className="flex flex-col gap-5 p-5 sm:p-7">
        <div className="flex items-center justify-between">
          <h2 id="add-doc-title" className="font-serif text-[28px] font-medium">
            Thêm tài liệu
          </h2>
          <button type="button" className="icon-btn text-muted" onClick={onClose} disabled={busy} aria-label="Đóng">
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="flex gap-2" role="tablist">
          {(["file", "link"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              disabled={busy}
              onClick={() => {
                setTab(t);
                setError(null);
              }}
              className="chip h-[42px]"
            >
              <Icon name={t === "file" ? "upload" : "link"} size={16} />
              {t === "file" ? "Tải tệp lên" : "Dán link"}
            </button>
          ))}
        </div>

        {tab === "file" ? (
          file ? (
            <div className="flex h-[72px] items-center gap-3.5 rounded-xl border border-line pl-4 pr-2">
              <span className="text-accent">
                <Icon name="file" size={26} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[15px] font-medium">{file.name}</span>
                <span className="text-[13px] text-muted">{formatSize(file.size)}</span>
              </span>
              <button type="button" className="btn-ghost px-3.5 text-sm text-accent" onClick={() => fileInput.current?.click()} disabled={busy}>
                Đổi tệp
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="flex h-[190px] flex-col items-center justify-center gap-2 rounded-[14px] border-[1.5px] border-dashed border-field bg-bg text-muted transition-colors hover:border-accent"
            >
              <span className="text-accent">
                <Icon name="upload" size={30} />
              </span>
              <span className="text-base font-medium text-ink">Bấm để chọn tệp từ máy</span>
              <span className="text-[13px]">PDF hoặc EPUB · tối đa 50 MB</span>
            </button>
          )
        ) : (
          <form onSubmit={submitLink} className="flex flex-col gap-3.5" id="add-link-form">
            <label className="field-label">
              Link bài viết hoặc tệp PDF
              <input
                className="input h-[50px] bg-page"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </label>
            <span className="text-[13px] leading-normal text-muted">
              PureMind tải trang về, bỏ quảng cáo và menu, giữ phần nội dung chính. Địa chỉ nội bộ bị chặn.
            </span>
          </form>
        )}
        <input ref={fileInput} type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" className="hidden" onChange={pickFile} />

        {error && <Alert>{error}</Alert>}

        <div className="flex justify-end gap-2.5">
          <button type="button" className="btn-outline h-12 px-5" onClick={onClose} disabled={busy}>
            Hủy
          </button>
          {tab === "file" ? (
            <button type="button" className="btn-primary h-12 px-[22px]" onClick={submitFile} disabled={busy}>
              {upload.isPending ? "Đang tải lên…" : file ? "Tải lên" : "Chọn tệp"}
            </button>
          ) : (
            <button type="submit" form="add-link-form" className="btn-primary h-12 px-[22px]" disabled={busy || !url.trim()}>
              {saveUrl.isPending ? "Đang lấy nội dung…" : "Lưu link"}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
