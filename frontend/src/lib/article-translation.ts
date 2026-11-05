"use client";

import { API_URL, ApiError, apiFetch } from "./api";
import { MSG } from "./messages";
import { readEvents } from "./notebooks";

/** A short read's text in Vietnamese. One kept on the server is anyone's to read; otherwise it is written for the
 * reader who asks, and this tab remembers it so that switching language back and forth does not write it again. */

const finished = new Map<string, string>();

/** The translation that already exists, or null: this needs no account and spends nothing. */
export async function readTranslation(id: string, signal?: AbortSignal): Promise<string | null> {
  const known = finished.get(id);
  if (known) return known;
  const res = await fetch(`${API_URL}/api/catalog/${encodeURIComponent(id)}/translation`, { signal });
  if (!res.ok) throw new ApiError(res.status, MSG["MSG-26"]);
  const { text } = (await res.json()) as { text: string | null };
  if (text) finished.set(id, text);
  return text;
}

/** Writes the translation, giving `onText` all of it so far after each piece, and resolves with the whole. */
export async function translateArticle(id: string, onText: (soFar: string) => void, signal?: AbortSignal): Promise<string> {
  const res = await apiFetch(`/catalog/${encodeURIComponent(id)}/translation`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.body) throw new ApiError(0, MSG["MSG-99"]);
  const parts: string[] = [];
  try {
    for await (const { event, data } of readEvents(res.body)) {
      const payload = JSON.parse(data);
      if (event === "delta") {
        parts.push(payload.text);
        onText(parts.join("\n\n"));
      } else if (event === "done") {
        const whole = parts.join("\n\n");
        finished.set(id, whole);
        return whole;
      } else if (event === "error") throw new ApiError(502, payload.detail ?? MSG["MSG-26"]);
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e;
    throw new ApiError(0, MSG["MSG-26"]); // connection dropped mid-stream
  }
  throw new ApiError(0, MSG["MSG-26"]);
}
