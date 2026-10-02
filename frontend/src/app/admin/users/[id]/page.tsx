"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { StatusBadges, describeAction } from "@/components/admin-parts";
import { Icon } from "@/components/icons";
import { Alert, ConfirmDialog, Spinner } from "@/components/ui";
import { formatBytes, formatDateTime, useAdminUser, useChangeUser, useDeleteUser, type AdminUserDetail } from "@/lib/admin";
import { formatDate } from "@/lib/documents";
import { useLang, useT, type Key } from "@/lib/i18n";
import type { ExtractionStatus } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

type Pending = "reset-quota" | "disable" | "enable" | "delete" | null;

const DOC_STATUS: [ExtractionStatus, Key][] = [
  ["done", "admin.docDone"],
  ["processing", "admin.docProcessing"],
  ["pending", "admin.docPending"],
  ["failed", "admin.docFailed"],
];

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="card flex flex-col gap-1 p-4">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="font-serif text-[28px] font-medium tabular-nums leading-tight">{value}</span>
      {hint && <span className="text-[13px] text-muted">{hint}</span>}
    </div>
  );
}

function Stats({ user }: { user: AdminUserDetail }) {
  const t = useT();
  const lang = useLang();
  const docHint = DOC_STATUS.filter(([s]) => user.documents_by_status[s])
    .map(([s, label]) => t(label, { n: user.documents_by_status[s] ?? 0 }))
    .join(" · ");
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label={t("admin.statDocuments")} value={user.document_count} hint={docHint || undefined} />
      <Stat label={t("admin.statStorage")} value={formatBytes(user.storage_bytes, lang)} />
      <Stat label={t("admin.statHighlights")} value={user.highlight_count} />
      <Stat label={t("admin.statNotebooks")} value={user.notebook_count} />
      <Stat label={t("admin.statConversations")} value={user.conversation_count} />
      <Stat label={t("admin.statSummaries")} value={user.summary_count} />
      <Stat label={t("admin.statAi")} value={`${user.ai_used_today} / ${user.ai_daily_quota}`} />
      <Stat label={t("admin.statChat")} value={`${user.chat_used_today} / ${user.chat_daily_quota}`} />
    </div>
  );
}

/** FR-ADM-03/04: one account, its usage and what an admin can do to it. Never its content. */
export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
  const t = useT();
  const lang = useLang();
  const router = useRouter();
  const showToast = useUi((s) => s.showToast);
  const { data: user, error, isPending } = useAdminUser(id);
  const change = useChangeUser(id);
  const remove = useDeleteUser(id);
  const [pending, setPending] = useState<Pending>(null);
  const [typed, setTyped] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const back = (
    <Link href="/admin/users" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <Icon name="back" size={16} />
      {t("admin.back")}
    </Link>
  );

  if (isPending) return <Spinner />;
  if (error || !user) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Alert>{error?.message}</Alert>
      </div>
    );
  }

  const busy = change.isPending || remove.isPending;
  const close = () => {
    setPending(null);
    setTyped("");
  };

  async function confirm() {
    if (!pending || !user) return;
    setActionError(null);
    try {
      if (pending === "delete") {
        await remove.mutateAsync();
        showToast(t("admin.deleteDone", { email: user.email }));
        router.replace("/admin/users");
        return;
      }
      await change.mutateAsync(pending);
      showToast(
        t(pending === "reset-quota" ? "admin.resetQuotaDone" : pending === "disable" ? "admin.disableDone" : "admin.enableDone"),
      );
    } catch (e) {
      setActionError((e as Error).message);
    }
    close();
  }

  const dialog: Record<Exclude<Pending, null>, { title: Key; body: Key; tone: "danger" | "primary" }> = {
    "reset-quota": { title: "admin.resetQuota", body: "admin.resetQuotaConfirm", tone: "primary" },
    disable: { title: "admin.disable", body: "admin.disableConfirm", tone: "danger" },
    enable: { title: "admin.enable", body: "admin.enableConfirm", tone: "primary" },
    delete: { title: "admin.delete", body: "admin.deleteConfirm", tone: "danger" },
  };
  const open = pending ? dialog[pending] : null;
  const isAdmin = user.role === "admin";

  return (
    <section className="flex flex-col gap-6">
      {back}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-serif text-[30px] font-medium leading-tight">{user.display_name || user.email}</h2>
          <StatusBadges user={user} />
        </div>
        {user.display_name && <span className="text-[15px] text-body">{user.email}</span>}
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          <div className="flex gap-1.5">
            <dt>{t("admin.createdAt")}:</dt>
            <dd className="text-body">{formatDate(user.created_at, lang)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>{t("admin.lastSeenAt")}:</dt>
            <dd className="text-body">{user.last_seen_at ? formatDateTime(user.last_seen_at, lang) : t("admin.never")}</dd>
          </div>
          {user.disabled_at && (
            <div className="flex gap-1.5">
              <dt>{t("admin.disabledAt")}:</dt>
              <dd className="text-danger">{formatDateTime(user.disabled_at, lang)}</dd>
            </div>
          )}
        </dl>
      </div>

      <Stats user={user} />

      <div className="card flex flex-col gap-4 p-5 sm:p-6">
        <h3 className="font-serif text-[22px] font-medium">{t("admin.actions")}</h3>
        {actionError && <Alert>{actionError}</Alert>}
        <div className="flex flex-wrap gap-2.5">
          <button type="button" className="btn-outline" disabled={busy} onClick={() => setPending("reset-quota")}>
            {t("admin.resetQuota")}
          </button>
          {user.disabled_at ? (
            <button type="button" className="btn-outline" disabled={busy} onClick={() => setPending("enable")}>
              {t("admin.enable")}
            </button>
          ) : (
            <button type="button" className="btn-outline" disabled={busy || isAdmin} onClick={() => setPending("disable")}>
              {t("admin.disable")}
            </button>
          )}
          <button type="button" className="btn-danger" disabled={busy || isAdmin} onClick={() => setPending("delete")}>
            {t("admin.delete")}
          </button>
        </div>
        {isAdmin && <p className="text-[13px] text-muted">{t("admin.protected")}</p>}
      </div>

      <div className="card flex flex-col gap-3 p-5 sm:p-6">
        <h3 className="font-serif text-[22px] font-medium">{t("admin.recentActions")}</h3>
        {user.recent_actions.length === 0 ? (
          <p className="text-sm text-muted">{t("admin.noActions")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {user.recent_actions.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2.5">
                <span className="text-ink">{describeAction(a, t)}</span>
                <span className="text-muted">
                  {a.admin_email} · {formatDateTime(a.created_at, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(open)}
        title={open ? t(open.title) : ""}
        tone={open?.tone}
        confirmLabel={open ? t(open.title) : undefined}
        cancelLabel={t("common.cancel")}
        busy={busy}
        confirmDisabled={pending === "delete" && typed.trim().toLowerCase() !== user.email}
        onConfirm={confirm}
        onCancel={close}
      >
        {open && (
          <div className="flex flex-col gap-3">
            <p>{t(open.body, { email: user.email })}</p>
            {pending === "delete" && (
              <label className="field-label">
                {t("admin.confirmEmail")}
                <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </label>
            )}
          </div>
        )}
      </ConfirmDialog>
    </section>
  );
}
