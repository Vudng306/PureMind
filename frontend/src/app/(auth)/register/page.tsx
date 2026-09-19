"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/auth-provider";
import { AuthTabs, GoogleSignIn } from "@/components/auth-parts";
import { SupabaseConfigNotice } from "@/components/config-notice";
import { Icon } from "@/components/icons";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { authErrorMessage } from "@/lib/auth-errors";
import { EMAIL_RE, MSG } from "@/lib/messages";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export default function RegisterPage() {
  const router = useRouter();
  const { session, loading } = useAuth();
  const [form, setForm] = useState({ displayName: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && session) router.replace("/library");
  }, [loading, session, router]);

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const email = form.email.trim().toLowerCase();
    const displayName = form.displayName.trim();
    // FR-AUTH-01 step 1: validate before calling Supabase
    if (displayName.length > 255) return setError(MSG["MSG-07"]);
    if (!EMAIL_RE.test(email) || email.length > 255) return setError(MSG["MSG-01"]);
    if (form.password.length < 8 || form.password.length > 72) return setError(MSG["MSG-02"]);
    if (form.password !== form.confirm) return setError("Mật khẩu xác nhận không khớp.");

    setBusy(true);
    const { data, error: authError } = await supabase().auth.signUp({
      email,
      password: form.password,
      options: { data: displayName ? { display_name: displayName } : {} },
    });
    if (authError) {
      setBusy(false);
      return setError(authErrorMessage(authError));
    }
    if (!data.session) {
      // Supabase returns no session when "Confirm email" is enabled, or silently for an existing email.
      setBusy(false);
      return setSentTo(email);
    }
    await api("/account").catch(() => undefined); // FR-AUTH-01 step 4: provision profile
    router.replace("/library");
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-[18px]">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-soft text-accent">
          <Icon name="mail" size={26} />
        </span>
        <h2 className="font-serif text-4xl font-medium">Kiểm tra hộp thư</h2>
        <p className="text-base leading-relaxed text-body">
          Chúng tôi đã gửi liên kết xác nhận tới <strong>{sentTo}</strong>. Bấm vào liên kết trong thư để kích hoạt tài
          khoản, sau đó đăng nhập.
        </p>
        <Link href="/login" className="btn-primary h-[50px] text-base">
          Đến trang đăng nhập
        </Link>
      </div>
    );
  }

  return (
    <>
      <h2 className="font-serif text-[40px] font-medium leading-tight">Tạo tài khoản</h2>
      <AuthTabs active="register" />
      {!isSupabaseConfigured && <SupabaseConfigNotice />}
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <label className="field-label">
          Họ tên
          <input className="input" autoComplete="name" value={form.displayName} onChange={update("displayName")} />
        </label>
        <label className="field-label">
          Email
          <input
            className="input"
            type="email"
            autoComplete="email"
            placeholder="ban@vidu.com"
            value={form.email}
            onChange={update("email")}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="field-label">
            Mật khẩu
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="8–72 ký tự"
              value={form.password}
              onChange={update("password")}
            />
          </label>
          <label className="field-label">
            Nhập lại mật khẩu
            <input className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={update("confirm")} />
          </label>
        </div>
        {error && <Alert>{error}</Alert>}
        <button className="btn-primary h-[50px] text-base" disabled={busy || !isSupabaseConfigured}>
          {busy ? "Đang tạo tài khoản…" : "Đăng ký"}
        </button>
      </form>
      <GoogleSignIn onError={setError} />
    </>
  );
}
