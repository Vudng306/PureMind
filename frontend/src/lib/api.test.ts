import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("./supabase", () => ({ supabase: () => ({ auth }) }));

import { api, ApiError, publicApi } from "./api";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("what a visitor may read", () => {
  const fetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetch);
    auth.signOut.mockResolvedValue({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("goes without a token when there is none, and does not end a session", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    fetch.mockResolvedValue(ok({ total: 1 }));
    expect(await publicApi("/feed")).toEqual({ total: 1 });
    const headers: Headers = fetch.mock.calls[0][1].headers;
    expect(headers.has("Authorization")).toBe(false);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("goes with the reader's token when signed in", async () => {
    auth.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    fetch.mockResolvedValue(ok({}));
    await publicApi("/feed");
    expect((fetch.mock.calls[0][1].headers as Headers).get("Authorization")).toBe("Bearer t");
  });

  it("still asks for an account for what is the reader's own", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    await expect(api("/documents")).rejects.toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
  });
});
