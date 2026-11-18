/** One of the six cover tones (globals.css .tone-1..6), the same one every time for the same title or topic. */
export function toneOf(key: string): string {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return `tone-${(Math.abs(hash) % 6) + 1}`;
}
