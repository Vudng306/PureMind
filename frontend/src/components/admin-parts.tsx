"use client";

import type { AdminAuditEntry, AdminUserItem, Page } from "@/lib/admin";
import { pageCount } from "@/lib/admin";
import { useT, type Key, type T } from "@/lib/i18n";

import { Icon } from "./icons";

export const SELECT_CLS =
  "h-10 max-w-full rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-accent";

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

const ACTION_LABEL: Record<AdminAuditEntry["action"], Key> = {
  "user.disable": "admin.actionDisable",
  "user.enable": "admin.actionEnable",
  "user.reset_quota": "admin.actionResetQuota",
  "user.delete": "admin.actionDelete",
};

/** "Reset credits · had used 20 AI and 7 chat credits": what was done, with the numbers kept at the time. */
export function describeAction(entry: AdminAuditEntry, t: T): string {
  const label = t(ACTION_LABEL[entry.action] ?? "admin.actions");
  const d = entry.detail;
  if (entry.action === "user.reset_quota" && "ai_used" in d) {
    return `${label} · ${t("admin.detailQuota", { ai: d.ai_used, chat: d.chat_used ?? 0 })}`;
  }
  if (entry.action === "user.delete" && "document_count" in d) {
    return `${label} · ${t("admin.detailDelete", { n: d.document_count })}`;
  }
  return label;
}
