"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import {
  MAX_CHAT_QUESTION,
  afterAnswer,
  askQuestion,
  citationLabel,
  citedSources,
  useConversation,
  useConversations,
  useCreateConversation,
  useDeleteConversation,
  type ChatCitation,
  type ChatMessage,
} from "@/lib/chat";
import { useDocument } from "@/lib/documents";
import { parseMarkdown } from "@/lib/markdown";
import { MSG, messageFor } from "@/lib/messages";
import { useAccount } from "@/lib/queries";

import { AiConsentDialog } from "./ai-consent-dialog";
import { Icon } from "./icons";
import { MarkdownView } from "./notebook-markdown";
import { ConfirmDialog } from "./ui";

/** Enough of a passage to find it again in the document (FR-RDR-04 find). */
const FIND_WORDS = 8;

function snippet(text: string): string {
  return text.trim().split(/\s+/).slice(0, FIND_WORDS).join(" ");
}

/** A [n] citation: opens the passage in the document. */
function Cite({ n, sources, onOpen }: { n: number; sources: Map<number, ChatCitation>; onOpen: (c: ChatCitation) => void }) {
  const cls = "mx-px rounded px-1 py-px align-[0.1em] font-sans text-[0.72em] font-semibold";
  const source = sources.get(n);
  if (!source) return <span className={`${cls} bg-soft text-muted`}>{n}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(source)}
      className={`${cls} bg-accent/15 text-accent hover:bg-accent/25`}
      title={`${citationLabel(source)}: “${source.text.slice(0, 120)}”`}
      aria-label={`Nguồn ${n}: ${citationLabel(source)}`}
    >
      {n}
    </button>
  );
}

function Answer({
  content,
  citations,
  onOpen,
}: {
  content: string;
  citations: ChatCitation[];
  onOpen: (c: ChatCitation) => void;
}) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const byPosition = useMemo(() => new Map(citations.map((c) => [c.position, c])), [citations]);
  const used = useMemo(() => citedSources(content, citations), [content, citations]);
  return (
    <div className="flex flex-col gap-2.5">
      <MarkdownView
        blocks={blocks}
        renderRef={(n) => <Cite n={n} sources={byPosition} onOpen={onOpen} />}
        className="text-[15px] leading-relaxed text-body [&_p]:mb-2.5 [&_ul]:mb-2.5 [&_ol]:mb-2.5"
      />
      {used.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {used.map((c) => (
            <button
              key={c.position}
              type="button"
              onClick={() => onOpen(c)}
              className="chip h-8 px-2.5 text-[12px]"
              title={c.text.slice(0, 200)}
            >
              <Icon name="file" size={13} className="text-muted" />
              {citationLabel(c)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ message, onOpen }: { message: ChatMessage; onOpen: (c: ChatCitation) => void }) {
  if (message.role === "user") {
    return (
      <p className="ml-6 self-end rounded-2xl rounded-br-md bg-soft px-3.5 py-2.5 text-[15px] leading-normal text-ink">
        {message.content}
      </p>
    );
  }
  return <Answer content={message.content} citations={message.citations} onOpen={onOpen} />;
}

/**
 * FR-CHAT-01..03: ask questions about the document being read. The answer is streamed and cites the
 * passages it used; a citation opens that passage in the document.
 */
export function ChatPanel({
  docId,
  quote,
  onClearQuote,
  onFind,
}: {
  docId: string;
  /** A passage the reader selected and wants to ask about (FR-RDR-06). */
  quote: string | null;
  onClearQuote: () => void;
  /** Open a passage in the document: the reader searches for it (FR-RDR-04). */
  onFind: (text: string) => void;
}) {
  const qc = useQueryClient();
  const { data: doc } = useDocument(docId);
  const { data: user } = useAccount();
  const { data: list } = useConversations(docId);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversation = useConversation(docId, conversationId);
  const create = useCreateConversation(docId);
  const remove = useDeleteConversation(docId);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null); // the question being answered
  const [streamed, setStreamed] = useState("");
  const [sources, setSources] = useState<ChatCitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<"consent" | "delete" | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const consented = Boolean(user?.reading_preferences.ai_consent);
  const quota = user?.chat_quota_remaining;
  const noText = doc?.extraction_status === "failed";
  const extracting = doc?.extraction_status === "pending" || doc?.extraction_status === "processing";
  const messages = conversation.data?.messages ?? [];
  const busy = pending !== null;

  // The newest thread of this document is the one that opens.
  useEffect(() => {
    if (conversationId === null && list?.length) setConversationId(list[0].id);
  }, [list, conversationId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages.length, streamed, pending]);

  async function send() {
    const content = draft.trim();
    if (!content || busy) return;
    if (!consented) return setAsk("consent");

    setError(null);
    setPending(content);
    setStreamed("");
    setSources([]);
    setDraft("");
    const asked = quote;
    try {
      let id = conversationId;
      if (!id) id = (await create.mutateAsync()).id;
      setConversationId(id);
      const result = await askQuestion(
        docId,
        id,
        { content, quote: asked },
        { onSources: setSources, onDelta: (text) => setStreamed((s) => s + text) },
      );
      afterAnswer(qc, docId, id, result);
      onClearQuote();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : MSG["MSG-99"]);
      setDraft(content); // the question is given back, unanswered and uncharged
    } finally {
      setPending(null);
      setStreamed("");
    }
  }

  async function startNew() {
    if (busy) return;
    setError(null);
    try {
      setConversationId((await create.mutateAsync()).id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : MSG["MSG-99"]);
    }
  }

  if (noText || extracting) {
    return (
      <p className="rounded-lg bg-soft px-3 py-2.5 text-sm leading-normal text-muted">
        {noText
          ? messageFor(doc?.extraction_error ?? "MSG-CHAT-NO-TEXT")
          : "Tài liệu đang được xử lý. Bạn có thể hỏi khi xử lý xong."}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {(list?.length ?? 0) > 0 && (
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="chat-conversation">
            Cuộc trò chuyện
          </label>
          <select
            id="chat-conversation"
            value={conversationId ?? ""}
            onChange={(e) => setConversationId(e.target.value || null)}
            disabled={busy}
            className="h-9 min-w-0 flex-1 rounded-full border border-field bg-surface pl-3 pr-7 text-[13px] text-ink outline-none focus:border-accent"
          >
            {list?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || "Cuộc trò chuyện mới"}
              </option>
            ))}
          </select>
          <button type="button" aria-label="Cuộc trò chuyện mới" onClick={() => void startNew()} disabled={busy} className="icon-btn text-muted">
            <Icon name="plus" size={16} />
          </button>
          <button
            type="button"
            aria-label="Xóa cuộc trò chuyện"
            onClick={() => setAsk("delete")}
            disabled={busy || !conversationId}
            className="icon-btn text-muted"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {messages.length === 0 && !busy && (
          <div className="flex flex-col gap-2 rounded-xl border border-line p-4">
            <p className="font-serif text-[17px] text-ink">Hỏi AI về tài liệu này</p>
            <p className="text-sm leading-relaxed text-muted">
              Câu trả lời chỉ dựa trên nội dung tài liệu và luôn kèm số đoạn đã dùng — bấm vào số đó để mở đúng
              đoạn trong bài.
            </p>
          </div>
        )}

        {messages.map((m) => (
          <Turn key={m.id} message={m} onOpen={(c) => onFind(snippet(c.text))} />
        ))}

        {pending && (
          <>
            <p className="ml-6 self-end rounded-2xl rounded-br-md bg-soft px-3.5 py-2.5 text-[15px] leading-normal text-ink">
              {pending}
            </p>
            {streamed ? (
              <Answer content={streamed} citations={sources} onOpen={(c) => onFind(snippet(c.text))} />
            ) : (
              <div role="status" className="flex items-center gap-2.5 text-sm text-muted">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
                Đang đọc tài liệu để trả lời…
              </div>
            )}
          </>
        )}
        <div ref={bottom} />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {quote && (
        <div className="flex items-start gap-2 rounded-xl border border-line px-3 py-2.5">
          <span className="min-w-0 flex-1 font-serif text-[14px] leading-normal text-muted">
            Hỏi về: “{quote.length > 140 ? `${quote.slice(0, 140)}…` : quote}”
          </span>
          <button type="button" aria-label="Bỏ đoạn đang hỏi" onClick={onClearQuote} className="icon-btn h-7 w-7 text-muted">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label className="sr-only" htmlFor="chat-question">
          Câu hỏi về tài liệu
        </label>
        <div className="flex items-end gap-2 rounded-[14px] border border-field bg-bg px-3 py-2 focus-within:border-accent">
          <textarea
            id="chat-question"
            value={draft}
            maxLength={MAX_CHAT_QUESTION}
            rows={2}
            placeholder="Hỏi về nội dung tài liệu…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy || quota === 0}
            className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-normal text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            aria-label="Gửi câu hỏi"
            onClick={() => void send()}
            disabled={busy || !draft.trim() || quota === 0}
            className="btn-primary mb-0.5 h-9 w-9 shrink-0 justify-center px-0"
          >
            <Icon name="arrow" size={16} />
          </button>
        </div>
        <span className={`text-xs ${quota === 0 ? "text-danger" : "text-muted"}`}>
          {quota === 0
            ? MSG["MSG-CHAT-QUOTA"]
            : quota === undefined
              ? "Enter để gửi, Shift+Enter để xuống dòng."
              : `Còn ${quota} câu hỏi hôm nay · Enter để gửi.`}
        </span>
      </div>

      <AiConsentDialog
        open={ask === "consent"}
        what="nội dung văn bản của tài liệu này"
        onAgreed={() => {
          setAsk(null);
          void send();
        }}
        onCancel={() => setAsk(null)}
      />

      <ConfirmDialog
        open={ask === "delete"}
        title="Xóa cuộc trò chuyện?"
        confirmLabel="Xóa"
        cancelLabel="Hủy"
        onConfirm={() => {
          setAsk(null);
          const id = conversationId;
          setConversationId(null);
          if (id) remove.mutate(id);
        }}
        onCancel={() => setAsk(null)}
      >
        Toàn bộ câu hỏi và câu trả lời trong cuộc trò chuyện này sẽ bị xóa. Tài liệu và highlight không bị ảnh
        hưởng.
      </ConfirmDialog>
    </div>
  );
}
