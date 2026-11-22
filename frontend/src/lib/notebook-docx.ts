import {
  AlignmentType,
  BorderStyle,
  Bookmark,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";

import type { ExportSource } from "./export";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import type { Lang } from "./types";

/**
 * FR-NB-03: the notebook as a Word file laid out like the page: the title, the line under it (created on, how
 * many sources), then the notebook's own headings and text. Each [n] is a small raised number that jumps to
 * its passage in the "Sources" list at the end, which keeps the numbers meaningful on paper.
 */

export interface NotebookDocxInput {
  title: string;
  /** The lines shown under the title on the page, already in the reader's language. */
  meta: string[];
  content: string;
  sources: ExportSource[];
  lang: Lang;
  /** The app's address, for a link from each source back to its passage in the reader. */
  origin?: string;
  now?: Date;
}

const FONT = "Cambria"; // a serif with full Vietnamese coverage on Windows and macOS
const MONO = "Consolas";
const INK = "1F1D1A";
const MUTED = "6B6660";
const ACCENT = "2F54EB";
const LINE = "D9D4CC";
const SOFT = "F3F0EB";
const SOURCE_QUOTE_CHARS = 300;
const CITE = /\[(\d{1,3})\]/g;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const bookmarkOf = (n: number) => `source_${n}`;

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  color?: string;
}

const plainText = (nodes: Inline[]): string =>
  nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : plainText(n.c))).join("");

/** Text with its [n] turned into raised numbers that link to the source list (when that source exists). */
function textRuns(v: string, style: RunStyle, cited: Set<number>): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  let last = 0;
  for (const m of v.matchAll(CITE)) {
    if (m.index > last) out.push(new TextRun({ text: v.slice(last, m.index), ...style }));
    // "[2][3]" reads as 2,3 rather than 23.
    else if (out.length > 0) out.push(new TextRun({ text: ",", superScript: true, color: MUTED }));
    const n = Number(m[1]);
    const mark = new TextRun({ text: String(n), superScript: true, bold: true, color: cited.has(n) ? ACCENT : MUTED });
    out.push(cited.has(n) ? new InternalHyperlink({ anchor: bookmarkOf(n), children: [mark] }) : mark);
    last = m.index + m[0].length;
  }
  if (last < v.length) out.push(new TextRun({ text: v.slice(last), ...style }));
  return out;
}

function inlineRuns(nodes: Inline[], cited: Set<number>, style: RunStyle = {}): ParagraphChild[] {
  return nodes.flatMap((n): ParagraphChild[] => {
    switch (n.t) {
      case "text":
        return textRuns(n.v, style, cited);
      case "strong":
        return inlineRuns(n.c, cited, { ...style, bold: true });
      case "em":
        return inlineRuns(n.c, cited, { ...style, italics: true });
      case "code":
        return [new TextRun({ text: n.v, font: MONO, size: 20, shading: { type: ShadingType.CLEAR, fill: SOFT, color: "auto" } })];
      case "br":
        return [new TextRun({ break: 1 })];
      case "link":
        return [
          new ExternalHyperlink({
            link: n.href,
            children: [new TextRun({ text: plainText(n.c), style: "Hyperlink", ...style })],
          }),
        ];
    }
  });
}

const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;

function blockParts(block: Block, cited: Set<number>, listCount: { n: number }): (Paragraph | Table)[] {
  switch (block.t) {
    case "heading":
      return [new Paragraph({ heading: HEADINGS[block.level], keepNext: true, children: inlineRuns(block.c, cited) })];
    case "paragraph":
      return [new Paragraph({ children: inlineRuns(block.c, cited) })];
    case "quote":
      return [
        new Paragraph({
          indent: { left: 360 },
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: LINE, space: 12 } },
          children: inlineRuns(block.c, cited, { italics: true, color: MUTED }),
        }),
      ];
    case "code":
      return block.v.split("\n").map(
        (line) =>
          new Paragraph({
            spacing: { after: 0 },
            shading: { type: ShadingType.CLEAR, fill: SOFT, color: "auto" },
            children: [new TextRun({ text: line || " ", font: MONO, size: 19 })],
          }),
      );
    case "math":
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: block.tex, font: MONO, size: 20, color: MUTED })],
        }),
      ];
    case "list": {
      // Every numbered list starts again at 1.
      const instance = block.ordered ? ++listCount.n : 0;
      return block.items.map(
        (item) =>
          new Paragraph({
            spacing: { after: 80 },
            ...(block.ordered
              ? { numbering: { reference: "ordered", level: Math.min(item.depth, 2), instance } }
              : { bullet: { level: Math.min(item.depth, 2) } }),
            children: inlineRuns(item.c, cited),
          }),
      );
    }
    case "table": {
      const columns = Math.max(...block.rows.map((r) => r.length), 1);
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.rows.map(
            (row, r) =>
              new TableRow({
                tableHeader: r === 0 && block.head,
                children: Array.from({ length: columns }, (_, c) => {
                  const head = r === 0 && block.head;
                  return new TableCell({
                    shading: head ? { type: ShadingType.CLEAR, fill: SOFT, color: "auto" } : undefined,
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    children: [
                      new Paragraph({ spacing: { after: 0 }, children: inlineRuns(row[c] ?? [], cited, head ? { bold: true } : {}) }),
                    ],
                  });
                }),
              }),
          ),
        }),
        new Paragraph({ spacing: { after: 120 }, children: [] }),
      ];
    }
    case "image": // pictures the model linked are never fetched (see notebook-markdown.tsx)
    case "pagebreak":
      return [];
  }
}

function sourceParts(used: ExportSource[], lang: Lang, origin?: string): Paragraph[] {
  const en = lang === "en";
  const out = [
    new Paragraph({
      spacing: { before: 480 },
      keepNext: true, // never alone at the foot of a page
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 12 } },
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun(en ? "Sources" : "Nguồn")],
    }),
  ];
  for (const s of used) {
    const text = oneLine(s.highlight.selected_text);
    const quote = text.length > SOURCE_QUOTE_CHARS ? `${text.slice(0, SOURCE_QUOTE_CHARS).trimEnd()}…` : text;
    const page = s.highlight.page_number ? (en ? `, page ${s.highlight.page_number}` : `, trang ${s.highlight.page_number}`) : "";
    const where = `${oneLine(s.document_title)}${page}`;
    out.push(
      new Paragraph({
        spacing: { after: 160 },
        indent: { left: 480, hanging: 480 },
        children: [
          new Bookmark({ id: bookmarkOf(s.position), children: [new TextRun({ text: `${s.position}.`, bold: true, color: ACCENT })] }),
          new TextRun({ text: `\t“${quote}” — ` }),
          origin
            ? new ExternalHyperlink({
                link: `${origin}/reader/${s.highlight.document_id}?hl=${s.highlight.id}`,
                children: [new TextRun({ text: where, italics: true, style: "Hyperlink" })],
              })
            : new TextRun({ text: where, italics: true }),
        ],
      }),
    );
  }
  return out;
}

export function notebookDocument(input: NotebookDocxInput): Document {
  const { title, meta, content, sources, lang, origin } = input;
  const now = input.now ?? new Date();
  const en = lang === "en";
  const name = oneLine(title) || "Notebook";

  const blocks = parseMarkdown(content);
  // The AI writes the title as the first heading; the document already opens with it.
  const first = blocks[0];
  const body = first?.t === "heading" && first.level === 1 && oneLine(plainText(first.c)) === name ? blocks.slice(1) : blocks;

  const citedNumbers = new Set([...content.matchAll(CITE)].map((m) => Number(m[1])));
  const used = sources.filter((s) => citedNumbers.has(s.position)).sort((a, b) => a.position - b.position);
  const cited = new Set(used.map((s) => s.position));
  const listCount = { n: 0 };

  const exported = en
    ? `Exported from PureMind on ${now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
    : `Xuất từ PureMind ngày ${now.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })}`;

  return new Document({
    creator: "PureMind",
    title: name,
    styles: {
      default: {
        document: { run: { font: FONT, size: 24, color: INK }, paragraph: { spacing: { after: 160, line: 312 } } },
        title: { run: { font: FONT, size: 52, color: INK }, paragraph: { spacing: { after: 120 } } },
        heading1: { run: { font: FONT, size: 34, bold: true, color: INK }, paragraph: { spacing: { before: 360, after: 160 } } },
        heading2: { run: { font: FONT, size: 28, bold: true, color: INK }, paragraph: { spacing: { before: 320, after: 120 } } },
        heading3: { run: { font: FONT, size: 25, bold: true, color: INK }, paragraph: { spacing: { before: 240, after: 100 } } },
        hyperlink: { run: { color: ACCENT, underline: {} } },
      },
    },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${exported} · `, size: 18, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 18, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(name)] }),
          ...meta
            .filter((line) => line.trim())
            .map((line, i, all) =>
              new Paragraph({
                spacing: { after: i === all.length - 1 ? 0 : 40 },
                children: [new TextRun({ text: line, size: 20, color: MUTED })],
              }),
            ),
          new Paragraph({
            spacing: { after: 240 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 8 } },
            children: [],
          }),
          ...body.flatMap((b) => blockParts(b, cited, listCount)),
          ...(used.length ? sourceParts(used, lang, origin) : []),
        ],
      },
    ],
  });
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function notebookDocxBlob(input: NotebookDocxInput): Promise<Blob> {
  return Packer.toBlob(notebookDocument(input));
}
