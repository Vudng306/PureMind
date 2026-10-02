"use client";

import Link from "next/link";
import { useState } from "react";

import { Pager, describeAction } from "@/components/admin-parts";
import { Alert, Spinner } from "@/components/ui";
import { formatDateTime, useAuditLog } from "@/lib/admin";
import { useLang, useT } from "@/lib/i18n";

/** FR-ADM-05: every change made from the admin pages, newest first. */
export default function AdminAuditPage() {
  const t = useT();
  const lang = useLang();
  const [page, setPage] = useState(1);
  const { data, error, isPending, isFetching } = useAuditLog(page);

  if (error) return <Alert>{error.message}</Alert>;
  if (isPending) return <Spinner />;

  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted";
  const td = "px-4 py-3 align-middle";

  return (
    <section className="flex flex-col gap-4">
      <h2 className="sr-only">{t("admin.auditTitle")}</h2>
      <div className={`card overflow-x-auto transition-opacity ${isFetching ? "opacity-60" : ""}`}>
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={th}>{t("admin.colTime")}</th>
              <th className={th}>{t("admin.colAction")}</th>
              <th className={th}>{t("admin.colTarget")}</th>
              <th className={th}>{t("admin.colAdmin")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id} className="border-b border-line last:border-0">
                <td className={`${td} whitespace-nowrap text-body`}>{formatDateTime(e.created_at, lang)}</td>
                <td className={`${td} text-ink`}>{describeAction(e, t)}</td>
                <td className={td}>
                  {/* A deleted account has no page left to open. */}
                  {e.target_user_id && e.action !== "user.delete" ? (
                    <Link href={`/admin/users/${e.target_user_id}`} className="text-ink underline-offset-2 hover:underline">
                      {e.target_email}
                    </Link>
                  ) : (
                    <span className="text-body">{e.target_email}</span>
                  )}
                </td>
                <td className={`${td} text-body`}>{e.admin_email}</td>
              </tr>
            ))}
            {data.items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted">
                  {t("admin.auditEmpty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager data={data} onPage={setPage} />
    </section>
  );
}
