"use client";

/** The Library as a reading list: tabs by reading state, one row per document, and a panel about the chosen one. */

import Link from "next/link";

import { Icon } from "@/components/icons";
import { KIND_LABEL, isProcessing, origin, progressLabel, progressOf, relativeTime, type ReadState } from "@/lib/doc-view";
import { useT, type Key } from "@/lib/i18n";
import { authorsShort } from "@/lib/library";
import { messageFor } from "@/lib/messages";
import { toneOf } from "@/lib/tone";
import type { DocumentListItem } from "@/lib/types";

/** What can be done to one document, from its row, its menu or the panel. */
export interface DocActions {
  onAddToNotebook: () => void;
  onCreatePost: () => void;
  onShareOriginal: () => void;
  onRename: () => void;
  onMove: () => void;
  onCite: () => void;
  onToggleRead: () => void;
  onDelete: () => void;
}

export type ReadTab = ReadState | "all";

const TABS: readonly (readonly [ReadTab, Key])[] = [
  ["all", "common.all"],
  ["unread", "library.readUnread"],
  ["reading", "library.readReading"],
  ["read", "library.readDone"],
];

/** Where a document stands with its reader, as tabs over the list. They sit on the toolbar's bottom line. */
export function ReadTabs({
  value,
  counts,
  onChange,
}: {
  value: ReadTab;
  counts: Record<ReadTab, number>;
  onChange: (value: ReadTab) => void;
}) {
  const t = useT();
  return (
    <div role="tablist" aria-label={t("library.readStatus")} className="flex min-w-0 gap-4 overflow-x-auto [scrollbar-width:none]">
      {TABS.map(([tab, label]) => {
        const active = value === tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab)}
            className={`-mb-px flex h-11 shrink-0 items-center gap-1.5 border-b-2 text-[13px] font-semibold uppercase tracking-[0.07em] transition-colors ${
              active ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t(label)}
            <span className={`text-xs font-medium tabular-nums ${active ? "text-accent-text" : "text-muted"}`}>{counts[tab]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The document's stand-in for a cover: its first letter on its own tone, with how far it has been read. */
function Cover({ doc, className }: { doc: DocumentListItem; className: string }) {
  const pct = progressOf(doc);
  return (
    <span
      aria-hidden
      className={`cover-art ${toneOf(doc.title)} relative grid shrink-0 place-items-center overflow-hidden font-display font-semibold ${className}`}
    >
      {doc.title.trim().charAt(0).toUpperCase() || "?"}
      {pct > 0 && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-ink/10">
          <span className={`block h-full ${pct >= 100 ? "bg-success" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}

function Status({ doc }: { doc: DocumentListItem }) {
  const t = useT();
  const pct = progressOf(doc);
  if (isProcessing(doc)) {
    return (
      <span role="status" className="text-accent-text">
        {t("library.extracting")}
      </span>
    );
  }
  if (doc.extraction_status === "failed") return <span className="text-danger">{messageFor(doc.extraction_error)}</span>;
  if (pct >= 100) {
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <Icon name="check" size={13} />
        {progressLabel(doc, pct)}
      </span>
    );
  }
  return <span className={pct > 0 ? "font-medium text-accent-text" : ""}>{progressLabel(doc, pct)}</span>;
}

/** One document on one row. The whole row opens it; the buttons at its end act on it without opening. */
export function DocumentRow({
  doc,
  selected,
  onSelect,
  actions,
  menu,
}: {
  doc: DocumentListItem;
  selected: boolean;
  onSelect: () => void;
  actions: DocActions;
  menu: React.ReactNode;
}) {
  const t = useT();
  const byline = [authorsShort(doc), origin(doc)].filter(Boolean).join(" · ");
  return (
    <li
      data-doc={doc.id}
      onMouseEnter={onSelect}
      className={`group relative flex scroll-mb-6 scroll-mt-24 items-center gap-3.5 border-b border-line px-3 py-3 transition-colors ${
        selected ? "bg-surface" : ""
      }`}
    >
      {selected && <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-full bg-accent" />}
      <Cover doc={doc} className="h-[52px] w-10 rounded-md text-xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Link
          href={`/reader/${doc.id}`}
          onFocus={onSelect}
          className="truncate text-[15px] font-semibold leading-snug text-ink after:absolute after:inset-0 hover:underline"
        >
          {doc.title}
        </Link>
        <span className="truncate text-[13px] text-body">{byline}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="shrink-0 rounded bg-soft px-1.5 py-px text-[10px] font-bold tracking-wide text-ink">{KIND_LABEL[doc.file_type]}</span>
          <span className="truncate">
            <Status doc={doc} />
          </span>
        </span>
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-0.5">
        <span className={`pr-2 text-xs tabular-nums text-muted ${selected ? "hidden" : "group-hover:hidden"}`}>
          {relativeTime(doc.updated_at)}
        </span>
        <span className={`items-center gap-0.5 ${selected ? "flex" : "hidden group-hover:flex"}`}>
          <button
            type="button"
            className="icon-btn h-9 w-9"
            aria-label={t(doc.is_read ? "library.markUnread" : "library.markRead")}
            title={t(doc.is_read ? "library.markUnread" : "library.markRead")}
            onClick={actions.onToggleRead}
          >
            <Icon name={doc.is_read ? "minus" : "check"} size={17} />
          </button>
          <button
            type="button"
            className="icon-btn h-9 w-9"
            aria-label={t("library.addToNotebook")}
            title={t("library.addToNotebook")}
            onClick={actions.onAddToNotebook}
          >
            <Icon name="note" size={17} />
          </button>
        </span>
        {menu}
      </div>
    </li>
  );
}

/** The chosen document, without opening it: what it is, how far it has been read, and what can be done with it. */
export function InfoPanel({
  doc,
  shelf,
  highlights,
  actions,
}: {
  doc: DocumentListItem | null;
  shelf: string | null;
  highlights: number;
  actions: DocActions | null;
}) {
  const t = useT();
  const frame =
    "sticky top-[92px] hidden max-h-[calc(100dvh-112px)] flex-col gap-4 self-start overflow-y-auto rounded-[18px] border border-line bg-surface p-5 shadow-card min-[1400px]:flex";

  if (!doc || !actions) {
    return (
      <aside aria-label={t("library.info")} className={frame}>
        <span className="eyebrow">{t("library.info").toUpperCase()}</span>
        <p className="text-sm leading-relaxed text-muted">{t("library.infoEmpty")}</p>
      </aside>
    );
  }

  const pct = progressOf(doc);
  const failed = doc.extraction_status === "failed";
  const authors = (doc.citation?.authors ?? []).map((a) => (a.given ? `${a.given} ${a.family}` : a.family)).join(", ");
  const length = [
    doc.page_count ? t("library.pages", { n: doc.page_count }) : "",
    doc.word_count ? t("library.words", { n: doc.word_count.toLocaleString() }) : "",
    doc.reading_minutes ? t("library.minutes", { n: doc.reading_minutes }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const published = [doc.citation?.container, doc.citation?.year].filter(Boolean).join(", ");
  const facts: [Key, string][] = [
    ["library.infoSource", origin(doc)],
    ["library.infoAuthors", authors],
    ["library.infoPublished", published],
    ["library.infoType", KIND_LABEL[doc.file_type]],
    ["library.infoLength", length],
    ["library.infoAdded", relativeTime(doc.created_at)],
    ["library.collectionLabel", shelf ?? t("library.noCollection")],
    ["library.highlights", String(highlights)],
  ];
  const act = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-body hover:bg-soft hover:text-ink";

  return (
    <aside aria-label={t("library.info")} className={frame}>
      <span className="eyebrow">{t("library.info").toUpperCase()}</span>
      <div className="flex items-start gap-3.5">
        <Cover doc={doc} className="h-[84px] w-16 rounded-lg text-[34px]" />
        <h2 className="line-clamp-4 min-w-0 font-display text-lg font-semibold leading-snug text-ink">{doc.title}</h2>
      </div>

      {!failed && !isProcessing(doc) && (
        <div className="flex flex-col gap-1.5">
          <span className="h-1.5 rounded-full bg-soft">
            <span className={`block h-1.5 rounded-full ${pct >= 100 ? "bg-success" : "bg-accent"}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="text-[13px] text-muted">{progressLabel(doc, pct)}</span>
        </div>
      )}
      <span className="text-[13px] empty:hidden">{(failed || isProcessing(doc)) && <Status doc={doc} />}</span>

      <Link href={`/reader/${doc.id}`} className="btn-primary h-11 justify-center">
        {t(failed ? "library.viewOriginal" : pct > 0 && pct < 100 ? "library.continueRead" : "library.readAction")}
        <Icon name="arrow" />
      </Link>

      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{t(label)}</dt>
              <dd className="min-w-0 break-words text-ink">{value}</dd>
            </div>
          ))}
      </dl>

      {doc.url && (
        <a href={doc.url} target="_blank" rel="noopener noreferrer" className="btn-outline h-10 justify-center text-sm">
          <Icon name="link" size={16} />
          {t("library.openOriginal")}
        </a>
      )}

      <div className="flex flex-col gap-0.5 border-t border-line pt-3">
        <button type="button" className={act} onClick={actions.onAddToNotebook}>
          <Icon name="note" size={16} />
          {t("library.addToNotebook")}
        </button>
        <button type="button" className={act} onClick={actions.onMove}>
          <Icon name="file" size={16} />
          {t("library.moveToCollection")}
        </button>
        <button type="button" className={act} onClick={actions.onCite}>
          <Icon name="quote" size={16} />
          {t("library.cite")}
        </button>
        <button type="button" className={act} onClick={actions.onRename}>
          <Icon name="pencil" size={16} />
          {t("common.rename")}
        </button>
        <button type="button" className={act} onClick={actions.onToggleRead}>
          <Icon name={doc.is_read ? "minus" : "check"} size={16} />
          {t(doc.is_read ? "library.markUnread" : "library.markRead")}
        </button>
        <button type="button" className={`${act} text-danger hover:text-danger`} onClick={actions.onDelete}>
          <Icon name="trash" size={16} />
          {t("library.removeFromLibrary")}
        </button>
      </div>

      <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">{t("library.keys")}</p>
    </aside>
  );
}
