"use client";

import { useState } from "react";

import { ApiError } from "@/lib/api";
import { formatDate, useDocument } from "@/lib/documents";
import { MSG, messageFor } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import { useCreateSummary, useSummary, type SummaryLanguage } from "@/lib/summary";

import { AiConsentDialog } from "./ai-consent-dialog";
import { Icon } from "./icons";
import { ConfirmDialog } from "./ui";

const LANGUAGES: [SummaryLanguage, string][] = [
  ["auto", "Theo tài liệu"],
  ["vi", "Tiếng Việt"],
  ["en", "English"],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

function Working({ replacing }: { replacing: boolean }) {
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-lg bg-soft px-3 py-2.5 text-sm text-muted">
      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
      {replacing ? "Đang tạo bản tóm tắt mới — bản cũ vẫn hiển thị đến khi xong." : "Đang tạo tóm tắt… tài liệu dài có thể mất khoảng một phút."}
    </div>
  );
}

/** FR-SUM-01/02: the document's AI summary in the reader panel. */
export function SummaryPanel({ docId, onKeyword }: { docId: string; onKeyword: (keyword: string) => void }) {
  const { data: doc } = useDocument(docId);
  const { data: user } = useAccount();
  const { data: summary, isPending, isError, refetch } = useSummary(docId);
  const create = useCreateSummary(docId);
  const [language, setLanguage] = useState<SummaryLanguage>("auto");
  const [ask, setAsk] = useState<"consent" | "regenerate" | null>(null);

  const consented = Boolean(user?.reading_preferences.ai_consent);
  const quota = user?.ai_quota_remaining;
  const working = create.isPending;
  const noText = doc?.extraction_status === "failed";
  const extracting = doc?.extraction_status === "pending" || doc?.extraction_status === "processing";
  const error = create.error instanceof ApiError ? create.error.message : create.error ? MSG["MSG-99"] : null;

  function start() {
    create.reset();
    if (!consented) return setAsk("consent");
    if (summary) return setAsk("regenerate");
    create.mutate(language);
  }

  if (isPending) return <p className="text-sm text-muted">Đang tải tóm tắt…</p>;
  if (isError) {
    return (
      <p className="text-sm text-danger">
        Không tải được bản tóm tắt.{" "}
        <button type="button" className="underline" onClick={() => void refetch()}>
          Thử lại
        </button>
      </p>
    );
  }

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="summary-language">
        Ngôn ngữ tóm tắt
      </label>
      <select
        id="summary-language"
        value={language}
        onChange={(e) => setLanguage(e.target.value as SummaryLanguage)}
        disabled={working}
        className="h-10 rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent"
      >
        {LANGUAGES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={summary ? "btn-outline h-10" : "btn-primary h-10"}
        onClick={start}
        disabled={working || noText || extracting || quota === 0}
      >
        <Icon name="spark" size={16} />
        {summary ? "Tạo lại" : "Tạo tóm tắt"}
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      {summary ? (
        <>
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted">
              Tạo lúc {formatDate(summary.created_at)}{" "}
              {new Date(summary.created_at).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })} · {summary.ai_model}
            </span>
            {controls}
          </div>
          {working && <Working replacing />}
          {error && <p className="text-sm text-danger">{error}</p>}

          <Section title="Ý CHÍNH">
            <ol className="flex list-decimal flex-col gap-2 pl-5 font-serif text-[15px] leading-relaxed text-ink marker:text-muted">
              {summary.key_points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ol>
          </Section>

          {summary.concepts.length > 0 && (
            <Section title="KHÁI NIỆM">
              <dl className="flex flex-col gap-2.5">
                {summary.concepts.map((c, i) => (
                  <div key={i} className="rounded-lg border border-line px-3 py-2.5">
                    <dt className="text-sm font-semibold text-ink">{c.term}</dt>
                    <dd className="mt-0.5 text-sm leading-relaxed text-body">{c.explanation}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          <Section title="KẾT LUẬN">
            <p className="font-serif text-[15px] leading-relaxed text-ink">{summary.conclusion}</p>
          </Section>

          <Section title="TỪ KHÓA">
            <div className="flex flex-wrap gap-2">
              {summary.keywords.map((k) => (
                <button key={k} type="button" className="chip h-9 px-3.5" onClick={() => onKeyword(k)} aria-label={`Tìm “${k}” trong tài liệu`}>
                  {k}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted">Chọn một từ khóa để tìm nó trong tài liệu.</span>
          </Section>
        </>
      ) : (
        <div className="flex flex-col gap-3.5 rounded-xl border border-line p-4">
          <p className="font-serif text-[17px] text-ink">{MSG["MSG-33"]}</p>
          <p className="text-sm leading-relaxed text-muted">
            AI tóm tắt tài liệu thành 4 phần: Ý chính, Khái niệm, Kết luận và Từ khóa — chỉ dựa trên nội dung tài liệu.
          </p>
          {noText ? (
            <p className="text-sm text-danger">{messageFor(doc?.extraction_error ?? "MSG-15")}</p>
          ) : extracting ? (
            <p className="text-sm text-muted">Tài liệu đang được xử lý. Bạn có thể tạo tóm tắt khi xử lý xong.</p>
          ) : (
            controls
          )}
          {working && <Working replacing={false} />}
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}

      {quota !== undefined && (
        <span className={`text-xs ${quota === 0 ? "text-danger" : "text-muted"}`}>
          {quota === 0 ? MSG["MSG-25"] : `Còn ${quota} lượt AI hôm nay.`}
        </span>
      )}

      <AiConsentDialog
        open={ask === "consent"}
        what="nội dung văn bản của tài liệu này"
        onAgreed={() => {
          setAsk(null);
          create.mutate(language);
        }}
        onCancel={() => setAsk(null)}
      />

      <ConfirmDialog
        open={ask === "regenerate"}
        title="Tạo lại bản tóm tắt?"
        tone="primary"
        confirmLabel="Tạo lại"
        cancelLabel="Hủy"
        onConfirm={() => {
          setAsk(null);
          create.mutate(language);
        }}
        onCancel={() => setAsk(null)}
      >
        Bản tóm tắt mới sẽ thay thế bản hiện tại và dùng 1 lượt AI của hôm nay.
      </ConfirmDialog>
    </div>
  );
}
