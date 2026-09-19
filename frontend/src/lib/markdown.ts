/**
 * Parser for the Markdown subset produced by the backend extractors (SRS FR-RDR-05).
 * Output is plain data rendered as React elements, never as raw HTML (NFR-SEC-09).
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong" | "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { id: string; t: "heading"; level: 1 | 2 | 3; c: Inline[] }
  | { id: string; t: "paragraph"; c: Inline[] }
  | { id: string; t: "quote"; c: Inline[] }
  | { id: string; t: "code"; v: string }
  | { id: string; t: "list"; ordered: boolean; items: { depth: number; c: Inline[] }[] }
  | { id: string; t: "table"; rows: Inline[][][] }
  | { id: string; t: "pagebreak"; page: number };

type BlockData = Block extends infer B ? (B extends Block ? Omit<B, "id"> : never) : never;

/** FNV-1a, 32 bit, hex. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const SAFE_HREF = /^https?:\/\//i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[*_`[\]|\\]/.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    const wordBefore = i > 0 && /[\p{L}\p{N}]/u.test(src[i - 1]);
    if ((ch === "*" || (ch === "_" && !wordBefore)) && src[i + 1] && src[i + 1] !== " ") {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && src[end - 1] !== " ") {
        flush();
        out.push({ t: "em", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      if (m) {
        flush();
        const children = parseInline(m[1]);
        if (SAFE_HREF.test(m[2])) out.push({ t: "link", href: m[2], c: children });
        else out.push(...children);
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (trimmed[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += trimmed[i];
  }
  cells.push(cur.trim());
  return cells;
}

const cleanCell = (s: string) => s.replace(/<br\s*\/?>/gi, " ");

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const counts = new Map<string, number>();
  let page = 1;

  // Stable ids: content hash + occurrence number, so ids survive unrelated edits elsewhere.
  const push = (raw: string, block: BlockData) => {
    const key = hash(raw);
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    blocks.push({ ...block, id: `b${key}${n ? `-${n}` : ""}` } as Block);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^---\s*$/.test(line)) {
      page++;
      push(`---${page}`, { t: "pagebreak", page });
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      const v = body.join("\n");
      push("```" + v, { t: "code", v });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      push(line, { t: "heading", level, c: parseInline(heading[2].trim()) });
      i++;
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      const raw: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) raw.push(lines[i++]);
      const rows = raw
        .map(splitRow)
        .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)))
        .map((cells) => cells.map((cell) => parseInline(cleanCell(cell))));
      push(raw.join("\n"), { t: "table", rows });
      continue;
    }
    if (line.startsWith(">")) {
      const raw: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) raw.push(lines[i++].replace(/^>\s?/, ""));
      push("> " + raw.join("\n"), { t: "quote", c: parseInline(raw.join(" ")) });
      continue;
    }
    const listItem = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
    if (listItem.test(line)) {
      const raw: string[] = [];
      const items: { depth: number; c: Inline[] }[] = [];
      const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && listItem.test(lines[i])) {
        const m = listItem.exec(lines[i])!;
        raw.push(lines[i]);
        items.push({ depth: Math.floor(m[1].length / 2), c: parseInline(m[3]) });
        i++;
      }
      push(raw.join("\n"), { t: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>|\||---\s*$)/.test(lines[i]) &&
      !listItem.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      // Unrecognised line (e.g. stray pipe): keep it as text rather than looping forever.
      para.push(lines[i++].trim());
    }
    const text = para.join(" ");
    push(text, { t: "paragraph", c: parseInline(text) });
  }
  return blocks;
}
