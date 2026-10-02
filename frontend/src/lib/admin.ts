"use client";

/**
 * Admin page (FR-ADM): accounts and the audit log. The server answers with counts and account metadata
 * only — nothing a user read or wrote — and checks the admin role on every request.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./api";
import { currentLang } from "./preferences";
import type { ExtractionStatus, Lang } from "./types";

export type AdminUserStatus = "all" | "active" | "disabled" | "admin";
export type AdminUserSort = "newest" | "oldest" | "last_seen" | "email" | "documents" | "storage";
export type AdminAction = "user.disable" | "user.enable" | "user.reset_quota" | "user.delete";

export interface AdminUserItem {
  id: string;
  email: string;
  display_name: string | null;
  role: "user" | "admin";
  created_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
  document_count: number;
  storage_bytes: number;
  ai_used_today: number;
  chat_used_today: number;
}

export interface AdminAuditEntry {
  id: string;
  admin_email: string;
  action: AdminAction;
  target_user_id: string | null;
  target_email: string | null;
  detail: Record<string, number>;
  created_at: string;
}

export interface AdminUserDetail extends AdminUserItem {
  documents_by_status: Partial<Record<ExtractionStatus, number>>;
  highlight_count: number;
  notebook_count: number;
  conversation_count: number;
  summary_count: number;
  ai_daily_quota: number;
  chat_daily_quota: number;
  recent_actions: AdminAuditEntry[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminUserQuery {
  q: string;
  status: AdminUserStatus;
  sort: AdminUserSort;
  page: number;
}

const adminKey = ["admin"] as const;

export function useAdminUsers(query: AdminUserQuery) {
  return useQuery({
    queryKey: [...adminKey, "users", query],
    queryFn: () => {
      const params = new URLSearchParams({ status: query.status, sort: query.sort, page: String(query.page) });
      if (query.q.trim()) params.set("q", query.q.trim());
      return api<Page<AdminUserItem>>(`/admin/users?${params}`);
    },
    placeholderData: keepPreviousData,
  });
}

export function useAdminUser(id: string) {
  return useQuery({
    queryKey: [...adminKey, "user", id],
    queryFn: () => api<AdminUserDetail>(`/admin/users/${id}`),
    retry: false,
  });
}

export function useAuditLog(page: number) {
  return useQuery({
    queryKey: [...adminKey, "audit", page],
    queryFn: () => api<Page<AdminAuditEntry>>(`/admin/audit-log?page=${page}`),
    placeholderData: keepPreviousData,
  });
}

type UserChange = "disable" | "enable" | "reset-quota";

/** Lock, unlock or reset today's allowance; the answer is the account as it is now. */
export function useChangeUser(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (change: UserChange) => api<AdminUserDetail>(`/admin/users/${id}/${change}`, { method: "POST" }),
    onSuccess: (detail) => {
      qc.setQueryData([...adminKey, "user", id], detail);
      void qc.invalidateQueries({ queryKey: [...adminKey, "users"] });
      void qc.invalidateQueries({ queryKey: [...adminKey, "audit"] });
    },
  });
}

export function useDeleteUser(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>(`/admin/users/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: [...adminKey, "user", id] });
      void qc.invalidateQueries({ queryKey: [...adminKey, "users"] });
      void qc.invalidateQueries({ queryKey: [...adminKey, "audit"] });
    },
  });
}

export function pageCount(page: Page<unknown> | undefined): number {
  return page ? Math.max(1, Math.ceil(page.total / page.page_size)) : 1;
}

export function formatBytes(bytes: number, lang: Lang = currentLang()): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(lang === "en" ? "en-GB" : "vi-VN", { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function formatDateTime(iso: string, lang: Lang = currentLang()): string {
  return new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
