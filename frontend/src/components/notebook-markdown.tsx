"use client";

import Link from "next/link";
import { Fragment, useMemo } from "react";

import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";
import type { NotebookSource } from "@/lib/notebooks";

type Sources = Map<number, NotebookSource>;

/** A [n] citation: opens the source highlight in the reader, or says the source is gone (FR-NB-05). */
function Ref({ n, sources }: { n: number; sources: Sources | null }) {
  const cls = "mx-px rounded px-1 py-px align-[0.1em] font-sans text-[0.72em] font-semibold";
  if (!sources) return <span className={`${cls} bg-soft text-muted`}>{n}</span>; // still being written
  const s = sources.get(n);
  if (!s) {
    return (
      <span className={`${cls} bg-soft text-muted line-through`} title="Nguồn đã bị xóa" aria-label={`Nguồn ${n} đã bị xóa`}>
        {n}
      </span>
    );
  }
  return (
    <Link
      href={`/reader/${s.highlight.document_id}?hl=${s.highlight.id}`}
      className={`${cls} bg-accent/15 text-accent hover:bg-accent/25`}
      title={`${s.document_title}${s.highlight.page_number ? ` · trang ${s.highlight.page_number}` : ""}: “${s.highlight.selected_text.slice(0, 120)}”`}
      aria-label={`Nguồn ${n}: ${s.document_title}`}
    >
      {n}
    </Link>
  );
}

function Text({ v, sources }: { v: string; sources: Sources | null }) {
  const parts = v.split(/\[(\d{1,3})\]/);
  if (parts.length === 1) return <>{v}</>;
  return (
    <>
      {parts.map((p, i) => (i % 2 ? <Ref key={i} n={Number(p)} sources={sources} /> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

function Inlines({ nodes, sources }: { nodes: Inline[]; sources: Sources | null }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.t) {
          case "text":
            return <Text key={i} v={n.v} sources={sources} />;
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                <Inlines nodes={n.c} sources={sources} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={n.c} sources={sources} />
              </em>
            );
          case "code":
            return (
              <code key={i} className="rounded bg-soft px-1 py-0.5 font-mono text-[0.85em]">
                {n.v}
              </code>
            );
          case "link":
            return (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2">
                <Inlines nodes={n.c} sources={sources} />
              </a>
            );
        }
      })}
    </>
  );
}

function BlockView({ block, sources }: { block: Block; sources: Sources | null }) {
  switch (block.t) {
    case "heading": {
      const Tag = `h${block.level + 1}` as "h2" | "h3" | "h4"; // h1 is the page title
      const cls = {
        1: "mb-3 mt-2 text-[1.5em] font-semibold",
        2: "mb-2.5 mt-8 text-[1.2em] font-semibold",
        3: "mb-2 mt-6 text-[1.05em] font-semibold",
      }[block.level];
      return (
        <Tag className={`leading-[1.25] text-ink ${cls}`}>
          <Inlines nodes={block.c} sources={sources} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="mb-4">
          <Inlines nodes={block.c} sources={sources} />
        </p>
      );
    case "quote":
      return (
        <blockquote className="mb-4 border-l-[3px] border-line pl-4 italic text-muted">
          <Inlines nodes={block.c} sources={sources} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="mb-4 overflow-x-auto rounded-lg bg-soft p-3 font-mono text-[0.8em] leading-relaxed">
          <code>{block.v}</code>
        </pre>
      );
    case "list": {
      const ListTag = block.ordered ? "ol" : "ul";
      return (
        <ListTag className={`mb-4 space-y-1.5 pl-6 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-muted`}>
          {block.items.map((item, i) => (
            <li key={i} style={{ marginLeft: `${item.depth * 1.25}em` }}>
              <Inlines nodes={item.c} sources={sources} />
            </li>
          ))}
        </ListTag>
      );
    }
    case "table":
      return (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full border-collapse font-sans text-[0.85em]">
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className={r === 0 ? "bg-soft font-medium" : ""}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-line px-2.5 py-1.5 align-top">
                      <Inlines nodes={cell} sources={sources} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "pagebreak":
      return <hr className="my-6 border-line" />;
  }
}

const plain = (nodes: Inline[]): string =>
  nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : plain(n.c))).join("");

/**
 * Notebook Markdown rendered as React elements (never raw HTML, NFR-SEC-09), with clickable [n] citations.
 * A leading `# heading` equal to `title` is not repeated (the page already shows the title).
 */
export function NotebookMarkdown({
  content,
  sources,
  title,
}: {
  content: string;
  sources: NotebookSource[] | null;
  title?: string;
}) {
  const blocks = useMemo(() => {
    const all = parseMarkdown(content);
    const first = all[0];
    const same = first?.t === "heading" && first.level === 1 && plain(first.c).trim() === title?.trim();
    return same ? all.slice(1) : all;
  }, [content, title]);
  const byPosition = useMemo(() => (sources ? new Map(sources.map((s) => [s.position, s])) : null), [sources]);
  return (
    <div className="font-serif text-[17px] leading-[1.7] text-body [&>*:first-child]:mt-0">
      {blocks.map((b) => (
        <BlockView key={b.id} block={b} sources={byPosition} />
      ))}
    </div>
  );
}
