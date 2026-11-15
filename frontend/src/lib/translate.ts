"use client";

import { ApiError, apiFetch } from "./api";
import { MSG } from "./messages";
import { readEvents } from "./notebooks";

/** Translate a selected passage, English into Vietnamese or Vietnamese into English. Free for the user;
 * rate-limited on the server. */

export interface Translation {
  translation: string;
  source: string;
  target: string;
}

/** Fewer letters than this is a stray character or initial, not worth a request. */
const MIN_LETTERS = 2;

/**
 * Whether a selection reads as English, so the reader translates it as soon as it is selected. Most of its
 * letters must be plain a–z: Vietnamese carries marks on about a third of them and French on about a sixth,
 * while an English passage with a name like "Đặng" or "café" in it stays well above the limit.
 */
export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < MIN_LETTERS) return false;
  const plain = letters.filter((c) => /[a-z]/i.test(c)).length;
  return plain / letters.length >= 0.9;
}

const VI_LETTERS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/giu;

/** Whether a passage is Vietnamese, as the server decides it: enough of its letters carry Vietnamese marks. */
export function looksVietnamese(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  return (text.match(VI_LETTERS) ?? []).length / letters.length > 0.03;
}

// Selecting the same passage again (closing the card, reselecting) shows the translation already written
// instead of sending it to OpenAI again. Only this tab remembers, and only the last few.
const CACHE_SIZE = 30;
const cache = new Map<string, Translation>();

export function cachedTranslation(text: string): Translation | undefined {
  return cache.get(text.trim());
}

function remember(text: string, result: Translation) {
  cache.delete(text);
  cache.set(text, result);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
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
  const key = text.trim();
  const cached = cache.get(key);
  if (cached) return cached;
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
      else if (event === "done") {
        remember(key, payload as Translation);
        return payload as Translation;
      }
      else if (event === "error") throw new ApiError(502, payload.detail ?? MSG["MSG-26"]);
    }
  } catch (e) {
    if (e instanceof ApiError || signal?.aborted) throw e;
    throw new ApiError(0, MSG["MSG-26"]); // connection dropped mid-stream
  }
  throw new ApiError(0, MSG["MSG-26"]);
}
