"use client";

import { ApiError, apiFetch } from "./api";
import { MSG } from "./messages";
import { readEvents } from "./notebooks";

/** Translate a selected passage, English into Vietnamese. Free for the user; rate-limited on the server. */

export interface Translation {
  translation: string;
  source: string;
  target: string;
}

/**
 * Streams the translation to `onDelta` as it is written and resolves with the whole of it. Throws ApiError
 * when it fails.
 */
export async function translateText(
  text: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<Translation> {
  const res = await apiFetch("/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.body) throw new ApiError(0, MSG["MSG-99"]);
  try {
    for await (const { event, data } of readEvents(res.body)) {
      const payload = JSON.parse(data);
      if (event === "delta") onDelta(payload.text);
      else if (event === "done") return payload as Translation;
      else if (event === "error") throw new ApiError(502, payload.detail ?? MSG["MSG-26"]);
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e;
    throw new ApiError(0, MSG["MSG-26"]); // connection dropped mid-stream
  }
  throw new ApiError(0, MSG["MSG-26"]);
}
