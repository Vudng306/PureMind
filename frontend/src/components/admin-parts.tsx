"use client";

import { useState } from "react";

import type { AdminAuditEntry, AdminUserItem, Page } from "@/lib/admin";
import { pageCount } from "@/lib/admin";
import { niceMax } from "@/lib/admin-content";
import { TOPICS, type Topic } from "@/lib/feed";
import { useLang, useT, type Key, type T } from "@/lib/i18n";
import type { Lang } from "@/lib/types";

import { Icon } from "./icons";

export const SELECT_CLS =
  "h-10 max-w-full rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-focus";

const BADGE = {
  admin: "bg-ink text-bg",
  disabled: "bg-danger-soft text-danger",
  active: "bg-success-soft text-success",
} as const;

export function StatusBadges({ user }: { user: Pick<AdminUserItem, "role" | "disabled_at"> }) {
  const t = useT();
  const badge = (tone: keyof typeof BADGE, label: Key) => (
    <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ${BADGE[tone]}`}>{t(label)}</span>
  );
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {user.role === "admin" && badge("admin", "admin.badgeAdmin")}
      {user.disabled_at ? badge("disabled", "admin.badgeDisabled") : badge("active", "admin.badgeActive")}
    </span>
  );
}

export function Pager({ data, onPage }: { data?: Page<unknown>; onPage: (page: number) => void }) {
  const t = useT();
  if (!data) return null;
  const pages = pageCount(data);
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-muted">
      <span>{t("admin.pageInfo", { page: data.page, pages, total: data.total })}</span>
      <div className="flex gap-1">
        <button type="button" className="icon-btn" aria-label={t("admin.prev")} disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>
          <Icon name="back" />
        </button>
        <button type="button" className="icon-btn" aria-label={t("admin.next")} disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}>
          <Icon name="next" />
        </button>
      </div>
    </div>
  );
}

export function StatCard({ label, value, sub, alert = false }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className="card flex min-w-0 flex-col gap-1.5 p-5">
      <span className="text-[13px] font-semibold text-muted">{label}</span>
      <span className={`font-display text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${alert ? "text-danger" : "text-ink"}`}>
        {value}
      </span>
      <span className="text-[13px] text-muted">{sub}</span>
    </div>
  );
}

function shortDay(iso: string, lang: Lang) {
  // The day is Vietnam's, sent as a bare date: read it as such, not as UTC midnight.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === "en" ? "en-GB" : "vi-VN", { day: "2-digit", month: "2-digit" });
}

/** One measure per day as bars from a shared baseline; hovering a day reads its value in the header. */
export function DayBars({
  title,
  days,
  values,
  format,
}: {
  title: string;
  days: string[];
  values: number[];
  format: (value: number) => string;
}) {
  const lang = useLang();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(values);
  const total = values.reduce((a, b) => a + b, 0);
  const gap = days.length > 40 ? 1 : 2;

  return (
    <figure className="card flex flex-col gap-3 p-5">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <span className="text-sm tabular-nums text-muted" aria-live="polite">
          {hover !== null ? (
            <>
              {shortDay(days[hover], lang)} · <b className="font-semibold text-ink">{format(values[hover])}</b>
            </>
          ) : (
            <>
              Σ <b className="font-semibold text-ink">{format(total)}</b>
            </>
          )}
        </span>
      </figcaption>
      <div className="relative">
        <span className="absolute -top-2 left-0 max-w-[68px] truncate text-[11px] tabular-nums text-muted">{format(max)}</span>
        <div
          role="img"
          aria-label={`${title}: ${days.map((d, i) => `${shortDay(d, lang)} ${format(values[i])}`).join(", ")}`}
          className="ml-[72px] flex h-[150px] items-end border-b border-line"
          style={{ gap }}
          onMouseLeave={() => setHover(null)}
        >
          <span aria-hidden className="pointer-events-none absolute left-[72px] right-0 top-0 border-t border-dashed border-line" />
          {days.map((d, i) => (
            <span key={d} className="flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHover(i)}>
              <span
                className={`block w-full rounded-t-[4px] transition-colors ${hover === i ? "bg-ink" : "bg-accent"}`}
                style={{ height: values[i] ? `${Math.max((values[i] / max) * 100, 2)}%` : 0 }}
              />
            </span>
          ))}
        </div>
        <div className="ml-[72px] mt-1.5 flex justify-between text-[11px] tabular-nums text-muted">
          <span>{shortDay(days[0], lang)}</span>
          <span>{shortDay(days[days.length - 1], lang)}</span>
        </div>
      </div>
    </figure>
  );
}

const ACTION_LABEL: Record<AdminAuditEntry["action"], Key> = {
  "user.disable": "admin.actionDisable",
  "user.enable": "admin.actionEnable",
  "user.reset_quota": "admin.actionResetQuota",
  "user.delete": "admin.actionDelete",
  "article.hide": "admin.actionArticleHide",
  "article.show": "admin.actionArticleShow",
  "article.delete": "admin.actionArticleDelete",
  "article.add": "admin.actionArticleAdd",
  "crawl.run": "admin.actionCrawlRun",
  "crawl.settings": "admin.actionCrawlSettings",
  "crawl.source": "admin.actionCrawlSource",
  "channel.add": "admin.actionChannelAdd",
  "channel.update": "admin.actionChannelUpdate",
  "channel.delete": "admin.actionChannelDelete",
  "post.hide": "admin.actionPostHide",
  "post.show": "admin.actionPostShow",
  "post.delete": "admin.actionPostDelete",
  "comment.hide": "admin.actionCommentHide",
  "comment.show": "admin.actionCommentShow",
};

/** "Reset credits · had used 20 AI and 7 chat credits": what was done, with the numbers kept at the time. */
export function describeAction(entry: AdminAuditEntry, t: T): string {
  const label = t(ACTION_LABEL[entry.action] ?? "admin.actions");
  const d = entry.detail;
  if (entry.action === "user.reset_quota" && "ai_used" in d) {
    return `${label} · ${t("admin.detailQuota", { ai: Number(d.ai_used), chat: Number(d.chat_used ?? 0) })}`;
  }
  if (entry.action === "user.delete" && "document_count" in d) {
    return `${label} · ${t("admin.detailDelete", { n: Number(d.document_count) })}`;
  }
  // The article's title, the channel or the link: what the change was about, as it was named then.
  const about = d.title ?? d.key ?? d.url ?? (Array.isArray(d.sources) ? d.sources.join(", ") : d.source);
  if (entry.action === "crawl.settings") return `${label} · ${d.enabled ? `${String(d.hour).padStart(2, "0")}:00` : "—"}`;
  if (entry.action === "crawl.source") return `${label} · ${d.source} ${d.enabled ? "✓" : "✕"}`;
  return about ? `${label} · ${about}` : label;
}

/** Up to `max` of the feed's topics, picked as chips. */
export function TopicPicker({
  value,
  onChange,
  max = 4,
  label,
}: {
  value: Topic[];
  onChange: (topics: Topic[]) => void;
  max?: number;
  label: string;
}) {
  const t = useT();
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {TOPICS.map((topic) => {
        const on = value.includes(topic);
        return (
          <button
            key={topic}
            type="button"
            className="chip h-8 px-3 text-[13px]"
            aria-pressed={on}
            disabled={!on && value.length >= max}
            onClick={() => onChange(on ? value.filter((x) => x !== topic) : TOPICS.filter((x) => x === topic || value.includes(x)))}
          >
            {t(`feed.topic.${topic}` as Key)}
          </button>
        );
      })}
    </div>
  );
}

export function TopicTags({ topics }: { topics: string[] }) {
  const t = useT();
  return (
    <span className="flex flex-wrap gap-1">
      {topics.map((topic) => (
        <span key={topic} className="inline-flex h-6 items-center rounded-full bg-soft px-2 text-xs text-body">
          {(TOPICS as readonly string[]).includes(topic) ? t(`feed.topic.${topic}` as Key) : topic}
        </span>
      ))}
    </span>
  );
}
