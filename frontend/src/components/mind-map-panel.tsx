"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { ChatCitation } from "@/lib/chat";
import { useT } from "@/lib/i18n";
import {
  LINE_H,
  PAD_Y,
  edgePath,
  initiallyCollapsed,
  layoutMindMap,
  pathTo,
  scrollToShow,
  type MapLayout,
  type Placed,
} from "@/lib/mindmap";
import { scrollAfterZoom, useCoarsePointer, useCompact } from "@/lib/mobile";
import { findSnippet, type Artifact, type MapNode } from "@/lib/reader-ai";

import { ArtifactFrame } from "./ai-summary-panel";
import { AiBadge, Cites, SaveToNotes } from "./cite";
import { Icon } from "./icons";
import { useModal } from "./ui";

const MARGIN = 12;
const TOGGLE_R = 9;
const FONT = 12.5;
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.6;
// For a finger: a bigger circle to see, a bigger one still to hit, and room for it at the map's right edge.
const TOUCH_TOGGLE_R = 12;
const TOUCH_TARGET_R = 22;
const TOUCH_TARGET_MAX_R = 28;
const TOUCH_EDGE = 16;
/** Two columns fit on a phone at this size, with the labels still easy to read. */
const PHONE_SCALE = 0.85;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Changes the size of the map while what is in the middle of the scroller stays there. */
function zoomTo(box: HTMLElement | null, from: number, to: number, set: (s: number) => void) {
  if (!box) return set(to);
  const [x, y] = [box.clientWidth / 2, box.clientHeight / 2];
  const [left, top] = [box.scrollLeft + x, box.scrollTop + y];
  flushSync(() => set(to));
  box.scrollLeft = scrollAfterZoom(left, from, to, x);
  box.scrollTop = scrollAfterZoom(top, from, to, y);
}

/** Brings a node into the scroller's view, leaving the map alone when it can already be seen. */
function reveal(box: HTMLElement | null, layout: MapLayout, scale: number, id: string | undefined) {
  const p = layout.placed.find((c) => c.node.id === id);
  if (!box || !p) return;
  box.scrollTo(
    scrollToShow(
      { left: box.scrollLeft, top: box.scrollTop, width: box.clientWidth, height: box.clientHeight },
      { x: (p.x + MARGIN) * scale, y: (p.y + MARGIN) * scale, w: p.w * scale, h: p.h * scale },
    ),
  );
}

/** Two fingers on a phone resize the map around the point between them, and move it as they move. */
function usePinch(box: React.RefObject<HTMLDivElement | null>, on: boolean, scale: number, set: (s: number) => void) {
  const latest = useRef({ scale, set });
  latest.current = { scale, set };
  useEffect(() => {
    const el = box.current;
    if (!el || !on) return;
    const scroller = el;
    let start: { dist: number; scale: number; left: number; top: number } | null = null;

    function measure(e: TouchEvent) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const rect = scroller.getBoundingClientRect();
      return {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        x: (a.clientX + b.clientX) / 2 - rect.left,
        y: (a.clientY + b.clientY) / 2 - rect.top,
      };
    }
    function onStart(e: TouchEvent) {
      if (e.touches.length !== 2) return;
      const m = measure(e);
      start = { dist: m.dist, scale: latest.current.scale, left: scroller.scrollLeft + m.x, top: scroller.scrollTop + m.y };
    }
    function onMove(e: TouchEvent) {
      if (!start || e.touches.length < 2) return;
      e.preventDefault();
      const m = measure(e);
      const { dist, scale: from, left, top } = start;
      const next = clampScale(Math.round((from * m.dist * 100) / dist) / 100);
      flushSync(() => latest.current.set(next));
      scroller.scrollLeft = scrollAfterZoom(left, from, next, m.x);
      scroller.scrollTop = scrollAfterZoom(top, from, next, m.y);
    }
    function onEnd(e: TouchEvent) {
      if (e.touches.length < 2) start = null;
    }

    scroller.addEventListener("touchstart", onStart, { passive: true });
    scroller.addEventListener("touchmove", onMove, { passive: false });
    scroller.addEventListener("touchend", onEnd);
    scroller.addEventListener("touchcancel", onEnd);
    return () => {
      scroller.removeEventListener("touchstart", onStart);
      scroller.removeEventListener("touchmove", onMove);
      scroller.removeEventListener("touchend", onEnd);
      scroller.removeEventListener("touchcancel", onEnd);
    };
  }, [box, on]);
}

function onKey(run: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    run();
  };
}

function MapBox({
  p,
  selected,
  scale,
  touch,
  onSelect,
  onToggle,
}: {
  p: Placed;
  selected: boolean;
  scale: number;
  touch: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const t = useT();
  const depth = p.node.depth;
  // AI-109: a point that rests on no passage is the AI's own grouping, drawn with a broken outline.
  const unsourced = depth > 0 && p.node.sources.length === 0;
  const box = depth === 0 ? "fill-accent" : depth === 1 ? "fill-accent-soft" : "fill-surface";
  const text = depth === 0 ? "fill-on-accent" : depth === 1 ? "fill-accent-on-soft" : "fill-ink";
  const stroke = selected ? "stroke-ink" : depth >= 2 || unsourced ? "stroke-field" : "stroke-transparent";
  return (
    <g transform={`translate(${p.x},${p.y})`}>
      <g
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={unsourced ? `${p.node.label} (${t("ai.interpretation")})` : p.node.label}
        onClick={onSelect}
        onKeyDown={onKey(onSelect)}
        className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-focus"
      >
        <rect
          width={p.w}
          height={p.h}
          rx={10}
          strokeWidth={selected ? 2 : 1}
          strokeDasharray={unsourced ? "4 3" : undefined}
          className={`${box} ${stroke}`}
        />
        <text fontSize={FONT} fontWeight={depth < 2 ? 600 : 400} className={`${text} font-sans`}>
          {p.lines.map((line, i) => (
            <tspan key={i} x={10} y={PAD_Y + LINE_H * i + FONT}>
              {line}
            </tspan>
          ))}
        </text>
      </g>
      {p.children > 0 && (
        <g
          role="button"
          tabIndex={0}
          aria-expanded={!p.collapsed}
          aria-label={t(p.collapsed ? "ai.mapExpand" : "ai.mapCollapse", { label: p.node.label })}
          onClick={onToggle}
          onKeyDown={onKey(onToggle)}
          transform={`translate(${p.w},${p.h / 2})`}
          className="cursor-pointer outline-none [&:focus-visible>circle:last-of-type]:stroke-focus"
        >
          {/* The size a fingertip needs on the screen, whatever the map's zoom. */}
          {touch && <circle r={Math.min(TOUCH_TARGET_R / scale, TOUCH_TARGET_MAX_R)} fill="transparent" />}
          <circle r={touch ? TOUCH_TOGGLE_R : TOGGLE_R} className="fill-surface stroke-field" />
          <text textAnchor="middle" y={4} fontSize={11} fontWeight={600} className="fill-muted font-sans">
            {p.collapsed ? p.children : "−"}
          </text>
        </g>
      )}
    </g>
  );
}

/** The map itself, drawn from the validated tree: nothing the model wrote is used as markup. */
function MapCanvas({
  layout,
  scale,
  selected,
  onSelect,
  onToggle,
}: {
  layout: MapLayout;
  scale: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const t = useT();
  const touch = useCoarsePointer();
  const w = layout.width + MARGIN * 2 + TOGGLE_R + (touch ? TOUCH_EDGE : 0);
  const h = layout.height + MARGIN * 2;
  return (
    <svg
      width={w * scale}
      height={h * scale}
      viewBox={`${-MARGIN} ${-MARGIN} ${w} ${h}`}
      role="group"
      aria-label={t("ai.mapAria")}
      className="block max-w-none select-none"
    >
      {layout.edges.map((e) => (
        <path key={`${e.from.node.id}>${e.to.node.id}`} d={edgePath(e)} fill="none" strokeWidth={1.5} className="stroke-line" />
      ))}
      {layout.placed.map((p) => (
        <MapBox
          key={p.node.id}
          p={p}
          selected={p.node.id === selected}
          scale={scale}
          touch={touch}
          onSelect={() => onSelect(p.node.id)}
          onToggle={() => onToggle(p.node.id)}
        />
      ))}
    </svg>
  );
}

function Zoom({ scale, onScale, onFit }: { scale: number; onScale: (s: number) => void; onFit: () => void }) {
  const t = useT();
  const step = (d: number) => onScale(clampScale(Math.round((scale + d) * 10) / 10));
  return (
    <span className="flex items-center">
      <button type="button" aria-label={t("ai.zoomOut")} title={t("ai.zoomOut")} onClick={() => step(-0.1)} disabled={scale <= MIN_SCALE} className="icon-btn h-8 w-8 text-muted max-md:h-11 max-md:w-11">
        <Icon name="minus" size={15} />
      </button>
      <button type="button" onClick={onFit} title={t("ai.zoomFit")} className="h-8 min-w-[44px] rounded-lg px-1 text-xs tabular-nums text-muted hover:bg-soft hover:text-ink max-md:h-11">
        {Math.round(scale * 100)}%
      </button>
      <button type="button" aria-label={t("ai.zoomIn")} title={t("ai.zoomIn")} onClick={() => step(0.1)} disabled={scale >= MAX_SCALE} className="icon-btn h-8 w-8 text-muted max-md:h-11 max-md:w-11">
        <Icon name="plus" size={15} />
      </button>
    </span>
  );
}

/** What the chosen node says, where it comes from, and the button that keeps it. */
function NodeCard({
  docId,
  artifactId,
  nodes,
  node,
  sources,
  onOpen,
  onClose,
}: {
  docId: string;
  artifactId: string;
  nodes: MapNode[];
  node: MapNode | null;
  sources: Map<number, ChatCitation>;
  onOpen: (c: ChatCitation) => void;
  onClose?: () => void;
}) {
  const t = useT();
  if (!node) return <p className="text-[13px] leading-normal text-muted">{t("ai.mapHint")}</p>;
  const above = pathTo(nodes, node.id).slice(0, -1);
  const unsourced = node.parent !== null && node.sources.length === 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-line p-3.5">
      {above.length > 0 && <span className="text-xs text-muted">{above.map((n) => n.label).join(" › ")}</span>}
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 font-serif text-[16px] leading-snug text-ink">
          {node.label}
          <Cites ns={node.sources} sources={sources} onOpen={onOpen} />
        </p>
        <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifactId, part: `node:${node.id}` }} compact />
        {onClose && (
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="icon-btn -mr-1.5 -mt-1.5 text-muted">
            <Icon name="x" size={18} />
          </button>
        )}
      </div>
      {node.detail && <p className="text-sm leading-relaxed text-body">{node.detail}</p>}
      {unsourced && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs leading-normal text-muted">
          <AiBadge label={t("ai.interpretation")} />
          {t("ai.interpretationHint")}
        </p>
      )}
    </div>
  );
}

function MindMapView({
  docId,
  artifact,
  onOpen,
}: {
  docId: string;
  artifact: Artifact<"mindmap">;
  onOpen: (c: ChatCitation) => void;
}) {
  const t = useT();
  const compact = useCompact();
  const { nodes, citations } = artifact.payload;
  const [collapsed, setCollapsed] = useState(() => initiallyCollapsed(nodes));
  const [selected, setSelected] = useState<string | null>(null);
  const [scale, setScale] = useState(0.8);
  const [largeScale, setLargeScale] = useState(1);
  const [large, setLarge] = useState(false);
  const small = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLDivElement>(null);
  const dialog = useModal(large);
  // The node whose place on the screen is kept while the tree changes shape around it.
  const held = useRef<{ id: string; left: number; top: number } | null>(null);

  const layout = useMemo(() => layoutMindMap(nodes, collapsed), [nodes, collapsed]);
  const sources = useMemo(() => new Map(citations.map((c) => [c.position, c])), [citations]);
  const foldable = useMemo(() => {
    const parents = new Set(nodes.map((n) => n.parent));
    return nodes.filter((n) => n.parent !== null && parents.has(n.id)).map((n) => n.id);
  }, [nodes]);
  const node = nodes.find((n) => n.id === selected) ?? null;
  const unsourced = nodes.filter((n) => n.parent !== null && n.sources.length === 0).length;
  const rootId = nodes[0]?.id;

  const view = useRef({ layout, large, scale, largeScale });
  view.current = { layout, large, scale, largeScale };

  usePinch(small, compact, scale, setScale);
  usePinch(big, compact && large, largeScale, setLargeScale);

  // On a phone the full-screen map opens on its subject, and a chosen node stays clear of the card it brings up.
  // These run after useModal's effect, once the dialog is showing and the scroller has a size.
  useEffect(() => {
    if (compact && large) reveal(big.current, view.current.layout, view.current.largeScale, rootId);
  }, [compact, large, rootId]);
  useEffect(() => {
    if (compact && view.current.large && selected) reveal(big.current, view.current.layout, view.current.largeScale, selected);
  }, [compact, selected]);

  useLayoutEffect(() => {
    const keep = held.current;
    held.current = null;
    const now = view.current;
    const box = now.large ? big.current : small.current;
    const p = layout.placed.find((c) => c.node.id === keep?.id);
    if (!keep || !box || !p) return;
    const s = now.large ? now.largeScale : now.scale;
    box.scrollLeft = p.x * s - keep.left;
    box.scrollTop = p.y * s - keep.top;
  }, [layout]);

  function hold(id: string | undefined) {
    const box = large ? big.current : small.current;
    const s = large ? largeScale : scale;
    const p = layout.placed.find((c) => c.node.id === id);
    if (box && p) held.current = { id: p.node.id, left: p.x * s - box.scrollLeft, top: p.y * s - box.scrollTop };
  }

  function toggle(id: string) {
    hold(id);
    setCollapsed((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function foldTo(next: Set<string>) {
    hold(rootId);
    setCollapsed(next);
  }

  function fit(box: HTMLDivElement | null, set: (s: number) => void) {
    if (!box) return;
    const natural = layout.width + MARGIN * 2 + TOGGLE_R;
    set(Math.min(1, Math.max(MIN_SCALE, Math.floor(((box.clientWidth - 2) / natural) * 20) / 20)));
  }

  function openLarge() {
    if (compact) setLargeScale(PHONE_SCALE);
    setLarge(true);
  }

  const foldBtn = "h-8 whitespace-nowrap rounded-lg px-2 text-[13px] text-muted hover:bg-soft hover:text-ink disabled:opacity-40 max-md:h-11";
  const fold = (
    <>
      <button type="button" onClick={() => foldTo(new Set())} disabled={collapsed.size === 0} className={foldBtn}>
        {t("ai.mapOpenAll")}
      </button>
      <button type="button" onClick={() => foldTo(new Set(foldable))} disabled={foldable.every((id) => collapsed.has(id))} className={foldBtn}>
        {t("ai.mapFoldAll")}
      </button>
    </>
  );
  const largeZoom = (
    <Zoom scale={largeScale} onScale={(s) => zoomTo(big.current, largeScale, s, setLargeScale)} onFit={() => fit(big.current, setLargeScale)} />
  );
  // The passage opens in the document behind the dialog.
  const openFromLarge = (c: ChatCitation) => {
    setLarge(false);
    onOpen(c);
  };

  return (
    <>
      {compact ? (
        <button type="button" onClick={openLarge} className="btn-outline w-full">
          {t("ai.mapEnlarge")}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-x-1">
          <Zoom scale={scale} onScale={(s) => zoomTo(small.current, scale, s, setScale)} onFit={() => fit(small.current, setScale)} />
          {fold}
          <span className="flex-1" />
          <button type="button" onClick={openLarge} className="h-8 rounded-lg px-2 text-[13px] font-medium text-accent-text hover:bg-soft">
            {t("ai.mapEnlarge")}
          </button>
        </div>
      )}
      <div ref={small} className="max-h-[440px] touch-pan-x touch-pan-y overflow-auto rounded-xl border border-line bg-bg max-md:max-h-[45dvh]">
        <MapCanvas layout={layout} scale={scale} selected={selected} onSelect={setSelected} onToggle={toggle} />
      </div>
      {unsourced > 0 && <p className="text-xs leading-normal text-muted">{t("ai.mapLegend")}</p>}
      <NodeCard docId={docId} artifactId={artifact.id} nodes={nodes} node={node} sources={sources} onOpen={onOpen} />
      <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifact.id, part: "all" }} className="self-start" />

      <dialog
        ref={dialog}
        aria-label={t("ai.mapAria")}
        onCancel={(e) => {
          e.preventDefault();
          setLarge(false);
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setLarge(false);
        }}
        className={compact ? "dialog dialog-full" : "dialog w-[min(calc(100vw-32px),1180px)]"}
      >
        {large &&
          (compact ? (
            // A phone gives the map the whole screen: the title above it, what the thumb needs below it.
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 items-center gap-1 border-b border-line py-1 pl-4 pr-1">
                <h2 className="min-w-0 flex-1 truncate font-serif text-lg font-medium">{nodes[0]?.label}</h2>
                <button type="button" aria-label={t("common.close")} onClick={() => setLarge(false)} className="icon-btn text-muted">
                  <Icon name="x" size={20} />
                </button>
              </div>
              <div ref={big} className="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain bg-bg">
                <MapCanvas layout={layout} scale={largeScale} selected={selected} onSelect={setSelected} onToggle={toggle} />
              </div>
              <div className="max-h-[42dvh] shrink-0 overflow-y-auto border-t border-line px-3 py-2.5">
                <NodeCard
                  docId={docId}
                  artifactId={artifact.id}
                  nodes={nodes}
                  node={node}
                  sources={sources}
                  onOpen={openFromLarge}
                  onClose={() => setSelected(null)}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between gap-1 border-t border-line px-1 pb-[env(safe-area-inset-bottom)]">
                {largeZoom}
                <span className="flex items-center">{fold}</span>
              </div>
            </div>
          ) : (
            <div className="flex max-h-[calc(100dvh-34px)] flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center gap-x-1">
                <h2 className="mr-3 font-serif text-xl font-medium">{nodes[0]?.label}</h2>
                {largeZoom}
                {fold}
                <span className="flex-1" />
                <button type="button" aria-label={t("common.close")} onClick={() => setLarge(false)} className="icon-btn h-9 w-9 text-muted">
                  <Icon name="x" size={18} />
                </button>
              </div>
              <div ref={big} className="min-h-[240px] flex-1 overflow-auto rounded-xl border border-line bg-bg">
                <MapCanvas layout={layout} scale={largeScale} selected={selected} onSelect={setSelected} onToggle={toggle} />
              </div>
              <NodeCard docId={docId} artifactId={artifact.id} nodes={nodes} node={node} sources={sources} onOpen={openFromLarge} />
            </div>
          ))}
      </dialog>
    </>
  );
}

/** The reader's mind map: the document as a tree of themes and points, each tied to the passages behind it. */
export function MindMapPanel({ docId, onFind }: { docId: string; onFind: (text: string) => void }) {
  return (
    <ArtifactFrame docId={docId} kind="mindmap">
      {(artifact) => <MindMapView key={artifact.id} docId={docId} artifact={artifact} onOpen={(c) => onFind(findSnippet(c.text))} />}
    </ArtifactFrame>
  );
}
