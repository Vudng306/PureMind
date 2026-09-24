"use client";

import "katex/dist/katex.min.css";

import katex from "katex";
import { useMemo } from "react";

/**
 * A display equation typeset from its LaTeX. KaTeX builds the markup from the TeX itself and escapes all
 * text; `trust: false` keeps out \href, \url and the HTML-attribute commands, so this is the one place the
 * reader sets HTML it did not write element by element (NFR-SEC-09).
 */
export function MathBlock({ tex, className = "" }: { tex: string; className?: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: true,
        throwOnError: true,
        trust: false,
        strict: "ignore",
        maxSize: 20,
        maxExpand: 200,
      });
    } catch {
      return null; // LaTeX KaTeX cannot typeset: shown as the TeX itself
    }
  }, [tex]);
  if (html === null) {
    return <code className={`block overflow-x-auto whitespace-pre-wrap font-mono text-[0.85em] ${className}`}>{tex}</code>;
  }
  return <div className={`overflow-x-auto overflow-y-hidden ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
