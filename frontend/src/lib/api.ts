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

/** Sends the request with the session's token, refreshes it once on a 401, and turns an error reply into an ApiError.
 * `optional`: what a visitor may see too, so it goes without a token when there is none instead of to sign-in. */
async function authorized(
  base: HeadersInit | undefined,
  transport: (headers: Headers) => Promise<Response>,
  optional = false,
): Promise<Response> {
  const send = async (token: string | null) => {
    const headers = new Headers(base);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // So the server's own messages come back in the language the reader chose, not the browser's.
    headers.set("Accept-Language", usePreferences.getState().language);
    try {
      return await transport(headers);
    } catch {
      throw new ApiError(0, MSG["MSG-NET"]);
    }
  };

  let token = await currentToken();
  if (!token && !optional) return sessionExpired();

  let res = await send(token);
  if (res.status === 401 && token) {
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

export function apiFetch(path: string, init: RequestInit = {}, optional = false): Promise<Response> {
  return authorized(init.headers, (headers) => fetch(`${API_URL}/api${path}`, { ...init, headers }), optional);
}

/** A POST of a form whose bytes sent can be followed (`fetch` cannot report an upload's progress). */
export async function apiUpload<T>(path: string, body: FormData, onProgress: (fraction: number) => void): Promise<T> {
  const res = await authorized(undefined, (headers) => {
    onProgress(0);
    return new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_URL}/api${path}`);
      headers.forEach((value, name) => xhr.setRequestHeader(name, value));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.upload.onload = () => onProgress(1);
      xhr.onload = () =>
        resolve(new Response(xhr.status === 204 ? null : xhr.responseText, { status: xhr.status, statusText: xhr.statusText }));
      xhr.onerror = xhr.onabort = xhr.ontimeout = () => reject(new Error("network"));
      xhr.send(body);
    });
  });
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function api<T>(path: string, init: RequestInit = {}, optional = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await apiFetch(path, { ...init, headers }, optional);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A read a visitor may make too: with the reader's token when signed in, without one otherwise. */
export function publicApi<T>(path: string): Promise<T> {
  return api<T>(path, {}, true);
}
