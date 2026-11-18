import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("./supabase", () => ({ supabase: () => ({ auth }) }));

import { api, ApiError } from "./api";

describe("without a session", () => {
  const fetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetch);
    auth.signOut.mockResolvedValue({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("asks for an account", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } });
    await expect(api("/documents")).rejects.toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
  });
});
