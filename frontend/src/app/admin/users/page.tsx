"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Pager, SELECT_CLS, StatusBadges } from "@/components/admin-parts";
import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import {
  formatBytes,
  formatDateTime,
  useAdminUsers,
  type AdminUserSort,
  type AdminUserStatus,
} from "@/lib/admin";
import { formatDate } from "@/lib/documents";
import { useLang, useT, type Key } from "@/lib/i18n";

const STATUSES: [AdminUserStatus, Key][] = [
  ["all", "admin.statusAll"],
  ["active", "admin.statusActive"],
  ["disabled", "admin.statusDisabled"],
  ["admin", "admin.statusAdmin"],
];

const SORTS: [AdminUserSort, Key][] = [
  ["newest", "admin.sortNewest"],
  ["oldest", "admin.sortOldest"],
  ["last_seen", "admin.sortLastSeen"],
  ["email", "admin.sortEmail"],
  ["documents", "admin.sortDocuments"],
  ["storage", "admin.sortStorage"],
];

/** FR-ADM-02: every account, with how much it holds and uses, searchable by email or name. */
export default function AdminUsersPage() {
  const t = useT();
  const lang = useLang();
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<AdminUserStatus>("all");
  const [sort, setSort] = useState<AdminUserSort>("newest");
  const [page, setPage] = useState(1);

  // Search once typing pauses, not on every key.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(input);
      setPage(1);
    }, 300);
    return () => clearTimeout(id);
  }, [input]);

  const { data, error, isPending, isFetching } = useAdminUsers({ q, status, sort, page });

  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted";
  const td = "px-4 py-3 align-middle";

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("admin.statusFilter")}>
          {STATUSES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <span className="hidden flex-1 sm:block" />
        <label className="flex h-10 w-full items-center gap-2 rounded-full border border-field bg-surface px-3 text-muted focus-within:border-accent sm:w-[280px]">
          <Icon name="search" size={16} />
          <span className="sr-only">{t("admin.search")}</span>
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("admin.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
        </label>
        <label>
          <span className="sr-only">{t("admin.sort")}</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as AdminUserSort);
              setPage(1);
            }}
            className={SELECT_CLS}
          >
            {SORTS.map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <Alert>{error.message}</Alert>
      ) : isPending ? (
        <Spinner />
      ) : (
        <>
          <div className={`card overflow-x-auto transition-opacity ${isFetching ? "opacity-60" : ""}`}>
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>{t("admin.colUser")}</th>
                  <th className={th}>{t("admin.colStatus")}</th>
                  <th className={`${th} text-right`}>{t("admin.colDocuments")}</th>
                  <th className={`${th} text-right`}>{t("admin.colStorage")}</th>
                  <th className={`${th} text-right`}>{t("admin.colAiToday")}</th>
                  <th className={th}>{t("admin.colLastSeen")}</th>
                  <th className={th}>{t("admin.colCreated")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((u) => (
                  <tr key={u.id} className="border-b border-line last:border-0 hover:bg-soft">
                    <td className={td}>
                      <Link href={`/admin/users/${u.id}`} className="flex flex-col gap-0.5">
                        <span className="font-semibold text-ink">{u.display_name || u.email}</span>
                        {u.display_name && <span className="text-[13px] text-muted">{u.email}</span>}
                      </Link>
                    </td>
                    <td className={td}>
                      <StatusBadges user={u} />
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{u.document_count}</td>
                    <td className={`${td} text-right tabular-nums`}>{formatBytes(u.storage_bytes, lang)}</td>
                    <td className={`${td} text-right tabular-nums`}>
                      {u.ai_used_today} / {u.chat_used_today}
                    </td>
                    <td className={`${td} whitespace-nowrap text-body`}>
                      {u.last_seen_at ? formatDateTime(u.last_seen_at, lang) : t("admin.never")}
                    </td>
                    <td className={`${td} whitespace-nowrap text-body`}>{formatDate(u.created_at, lang)}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-muted">
                      {t("admin.noUsers")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager data={data} onPage={setPage} />
        </>
      )}
    </section>
  );
}
