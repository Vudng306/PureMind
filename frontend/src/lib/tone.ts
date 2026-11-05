const TONES = 10;

/** The tone of the nth of a list (the topics of a page): each its own, until there are more than ten. */
export function toneAt(index: number): string {
  return `tone-${(Math.max(index, 0) % TONES) + 1}`;
}

/** One of ten tones for a tag, the same one every time for the same words. */
export function tagTone(tag: string): string {
  let hash = 0;
  for (const ch of tag) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return toneAt(Math.abs(hash));
}

/** One of the six cover tones (globals.css .tone-1..6), the same one every time for the same title or topic. */
export function toneOf(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return `tone-${(Math.abs(hash) % 6) + 1}`;
}
