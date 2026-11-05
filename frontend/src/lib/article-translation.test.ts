import { afterEach, describe, expect, it, vi } from "vitest";

import { readTranslation, translateArticle } from "./article-translation";

vi.mock("./api", () => ({
  API_URL: "http://api.test",
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
  apiFetch: vi.fn(),
}));

import { apiFetch } from "./api";

function stream(...events: [string, unknown][]) {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text);
}

afterEach(() => vi.unstubAllGlobals());

describe("translateArticle", () => {
  it("gives the text so far after each piece, then remembers the whole", async () => {
    vi.mocked(apiFetch).mockResolvedValue(stream(["delta", { text: "Một." }], ["delta", { text: "Hai." }], ["done", { kept: false }]));
    const seen: string[] = [];

    await expect(translateArticle("written", (text) => seen.push(text))).resolves.toBe("Một.\n\nHai.");
    expect(seen).toEqual(["Một.", "Một.\n\nHai."]);

    // Switching language and back does not ask again, though a CC BY-ND translation is not on the server.
    const server = vi.fn();
    vi.stubGlobal("fetch", server);
    await expect(readTranslation("written")).resolves.toBe("Một.\n\nHai.");
    expect(server).not.toHaveBeenCalled();
  });

  it("fails with the server's message and remembers nothing", async () => {
    vi.mocked(apiFetch).mockResolvedValue(stream(["delta", { text: "Một." }], ["error", { detail: "Không dịch được" }]));

    await expect(translateArticle("failed", () => {})).rejects.toThrow("Không dịch được");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: null }))));
    await expect(readTranslation("failed")).resolves.toBeNull();
  });
});
