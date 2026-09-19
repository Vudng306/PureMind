"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/components/auth-provider";

import { api } from "./api";
import type { User } from "./types";

export const accountKey = ["account"] as const;

export function useAccount() {
  const { session } = useAuth();
  return useQuery({
    queryKey: accountKey,
    queryFn: () => api<User>("/account"),
    enabled: Boolean(session),
  });
}
