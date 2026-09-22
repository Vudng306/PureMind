import { MSG } from "./messages";
import { usePreferences } from "./preferences";
import { supabase } from "./supabase";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let refreshing: Promise<string | null> | null = null;

async function currentToken(): Promise<string | null> {
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}

/** FR-AUTH-03 step 4: concurrent 401s share a single refresh. */
function refreshToken(): Promise<string | null> {
  refreshing ??= supabase()
    .auth.refreshSession()
    .then(({ data, error }) => (error ? null : (data.session?.access_token ?? null)))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function sessionExpired(): Promise<never> {
  await supabase().auth.signOut({ scope: "local" }).catch(() => undefined);
  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.assign("/login?expired=1");
  }
  throw new ApiError(401, MSG["MSG-06"]);
}

export async function authHeader(): Promise<Record<string, string>> {
  const token = await currentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // So the server's own messages come back in the language the reader chose, not the browser's.
    headers.set("Accept-Language", usePreferences.getState().language);
    return fetch(`${API_URL}/api${path}`, { ...init, headers });
  };

  let token = await currentToken();
  if (!token) return sessionExpired();

  let res: Response;
  try {
    res = await send(token);
  } catch {
    throw new ApiError(0, MSG["MSG-NET"]);
  }
  if (res.status === 401) {
    token = await refreshToken();
    if (!token) return sessionExpired();
    res = await send(token);
    if (res.status === 401) return sessionExpired();
  }
  if (!res.ok) {
    let message: string = MSG["MSG-99"];
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") message = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return res;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await apiFetch(path, { ...init, headers });
  return (res.status === 204 ? undefined : await res.json()) as T;
}
