"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useHighlights } from "@/lib/annotations";
import { useDocuments, formatDate } from "@/lib/documents";
import { MAX_AVATAR_BYTES, MSG } from "@/lib/messages";
import { api } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { accountKey, useAccount } from "@/lib/queries";
import { supabase } from "@/lib/supabase";
import type { User } from "@/lib/types";
import { useUi } from "@/lib/ui-store";

import { Avatar } from "./avatar";
import { Icon } from "./icons";
import { Alert, ConfirmDialog, Spinner } from "./ui";

/** UI-11: FR-ACC-01..03, FR-ACC-05 — profile, avatar, password, sign-out and account deletion. */
export function AccountSettings() {
  const router = useRouter();
  const qc = useQueryClient();
  const showToast = useUi((s) => s.showToast);
  const { data: user, isLoading, isError, refetch } = useAccount();
  const { data: docs } = useDocuments("created_desc");
  const { data: highlights } = useHighlights();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) setName(user.display_name ?? "");
  }, [user]);

  const onSaved = (u: User, text: string = MSG["MSG-20"]) => {
    qc.setQueryData(accountKey, u);
    setNotice(null);
    showToast(text);
  };
  const onFailed = (err: unknown) =>
    setNotice({ tone: "danger", text: err instanceof Error ? err.message : MSG["MSG-99"] });

  const saveName = useMutation({
    mutationFn: (display_name: string) =>
      api<User>("/account", { method: "PATCH", body: JSON.stringify({ display_name }) }),
    onSuccess: (u) => onSaved(u, "Đã lưu hồ sơ"),
    onError: onFailed, // form keeps its value (FR-ACC-02)
  });

  const avatar = useMutation({
    mutationFn: (file: File | null) => {
      if (!file) return api<User>("/account/avatar", { method: "DELETE" });
      const body = new FormData();
      body.append("file", file);
      return api<User>("/account/avatar", { method: "PUT", body });
    },
    onSuccess: (u) => onSaved(u, "Đã cập nhật ảnh đại diện"),
    onError: onFailed,
  });

  const changePassword = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase().auth.updateUser({ password: value });
      if (error) throw new Error(authErrorMessage(error));
    },
    onSuccess: () => {
      setPassword("");
      setNotice(null);
      showToast("Đã đổi mật khẩu");
    },
    onError: onFailed,
  });

  const deleteAccount = useMutation({
    mutationFn: () => api<void>("/account", { method: "DELETE" }),
    onSuccess: async () => {
      await supabase().auth.signOut({ scope: "local" });
      router.replace("/login");
    },
    onError: (err) => {
      setDeleteOpen(false);
      onFailed(err);
    },
  });

  async function signOut() {
    // FR-AUTH-04: network errors never block clearing the local session
    await supabase()
      .auth.signOut()
      .catch(() => supabase().auth.signOut({ scope: "local" }));
    router.replace("/login");
  }

  if (isLoading) return <Spinner />;
  if (isError || !user) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Alert>{MSG["MSG-99"]}</Alert>
        <button type="button" className="btn-outline" onClick={() => refetch()}>
          Thử lại
        </button>
      </div>
    );
  }

  function submitName(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 255) return setNotice({ tone: "danger", text: MSG["MSG-07"] });
    saveName.mutate(trimmed);
  }

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    if (password.length < 8 || password.length > 72) return setNotice({ tone: "danger", text: MSG["MSG-02"] });
    changePassword.mutate(password);
  }

  function onAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setNotice(null);
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      return setNotice({ tone: "danger", text: MSG["MSG-08"] });
    }
    if (file.size > MAX_AVATAR_BYTES) return setNotice({ tone: "danger", text: MSG["MSG-09"] });
    avatar.mutate(file);
  }

  const docIds = new Set((docs ?? []).map((d) => d.id));
  const hlCount = highlights.filter((h) => docIds.has(h.docId)).length;
  const doneCount = (docs ?? []).filter((d) => d.is_read).length;

  return (
    <>
      <section className="card flex flex-col gap-6 p-6 sm:flex-row sm:gap-8 sm:p-7">
        <div className="flex shrink-0 flex-row items-center gap-3 sm:flex-col">
          <Avatar user={user} size={88} />
          <div className="flex flex-col gap-1">
            <button
              type="button"
              className="btn-ghost h-9 px-3 text-sm text-accent"
              onClick={() => avatarInput.current?.click()}
              disabled={avatar.isPending}
            >
              {avatar.isPending ? "Đang tải lên…" : "Đổi ảnh"}
            </button>
            {user.avatar_url && (
              <button
                type="button"
                className="btn-ghost h-9 px-3 text-sm text-muted"
                onClick={() => avatar.mutate(null)}
                disabled={avatar.isPending}
              >
                Xóa ảnh
              </button>
            )}
          </div>
          <input ref={avatarInput} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onAvatarFile} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h2 className="font-serif text-[26px] font-medium">Hồ sơ</h2>
          <form onSubmit={submitName} className="flex flex-col gap-4" id="profile-form">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field-label">
                Họ tên
                <input className="input h-[46px] bg-page" value={name} onChange={(e) => setName(e.target.value)} maxLength={300} />
              </label>
              <label className="field-label">
                Email
                <input className="input h-[46px] border-line bg-soft text-body" value={user.email} readOnly aria-readonly />
              </label>
            </div>
          </form>
          {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-dark h-[46px] px-[22px]" form="profile-form" disabled={saveName.isPending}>
              {saveName.isPending ? "Đang lưu…" : "Lưu hồ sơ"}
            </button>
            <span className="flex-1 text-sm text-muted">
              {(docs ?? []).length} tài liệu · {hlCount} highlight · {doneCount} đã đọc xong · tham gia {formatDate(user.created_at)}
            </span>
            <button type="button" onClick={signOut} className="btn-outline h-[46px] text-danger">
              <Icon name="logout" />
              Đăng xuất
            </button>
          </div>

          <form onSubmit={submitPassword} className="flex flex-col gap-2 border-t border-line pt-5 sm:flex-row sm:items-end sm:gap-3">
            <label className="field-label flex-1">
              Mật khẩu mới
              <input
                className="input h-[46px] bg-page"
                type="password"
                autoComplete="new-password"
                placeholder="8–72 ký tự"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button className="btn-outline h-[46px]" disabled={!password || changePassword.isPending}>
              {changePassword.isPending ? "Đang đổi…" : "Đổi mật khẩu"}
            </button>
          </form>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-[14px] border border-danger/30 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium text-danger">Xóa tài khoản</h2>
          <p className="text-sm text-muted">Toàn bộ tài liệu, tệp và dữ liệu của bạn sẽ bị xóa vĩnh viễn và không thể khôi phục.</p>
        </div>
        <button
          type="button"
          className="btn-outline self-start text-danger sm:self-auto"
          onClick={() => {
            setConfirmEmail("");
            setDeleteOpen(true);
          }}
        >
          Xóa tài khoản
        </button>
      </section>

      <ConfirmDialog
        open={deleteOpen}
        title="Xóa tài khoản vĩnh viễn?"
        confirmLabel="Xóa tài khoản"
        busy={deleteAccount.isPending}
        confirmDisabled={confirmEmail.trim().toLowerCase() !== user.email}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteAccount.mutate()}
      >
        <label className="flex flex-col gap-2">
          <span>
            Nhập <strong className="text-ink">{user.email}</strong> để xác nhận.
          </span>
          <input className="input" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} autoComplete="off" />
        </label>
      </ConfirmDialog>
    </>
  );
}
