"use client";

import { useMemo, useRef, useState } from "react";

import type { ChatCitation } from "@/lib/chat";
import { useT } from "@/lib/i18n";
import { LINE_H, PAD_Y, edgePath, initiallyCollapsed, layoutMindMap, pathTo, type MapLayout, type Placed } from "@/lib/mindmap";
import { findSnippet, type Artifact, type MapNode } from "@/lib/reader-ai";

import { ArtifactFrame } from "./ai-summary-panel";
import { AiBadge, Cites, SaveToNotes } from "./cite";
import { Icon } from "./icons";
import { useTouchZoom } from "./mobile-surfaces";
import { useModal } from "./ui";

const MARGIN = 12;
const TOGGLE_R = 9;
const FONT = 12.5;
const MIN_SCALE = 0.4;
const MAX_SCALE = 1.6;

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
  onSelect,
  onToggle,
}: {
  p: Placed;
  selected: boolean;
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
          className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-focus"
        >
          <circle r={TOGGLE_R} className="fill-surface stroke-field" />
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
  const w = layout.width + MARGIN * 2 + TOGGLE_R;
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
          onSelect={() => onSelect(p.node.id)}
          onToggle={() => onToggle(p.node.id)}
        />
      ))}
    </svg>
  );
}

function ZoomCanvas({ boxRef, scale, onScale, children }: { boxRef: React.RefObject<HTMLDivElement | null>; scale: number; onScale: (value: number) => void; children: React.ReactNode }) {
  useTouchZoom(boxRef, scale, onScale, MIN_SCALE, MAX_SCALE);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  return <div ref={boxRef} className="min-h-[240px] flex-1 overflow-auto rounded-xl border border-line bg-bg"
    onPointerDown={(event) => {
      if (event.pointerType !== "mouse" || (event.target as Element).closest("[role=button]")) return;
      const box = event.currentTarget;
      drag.current = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
      box.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
      event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
    }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
  >{children}</div>;
}

function Zoom({ scale, onScale, onFit }: { scale: number; onScale: (s: number) => void; onFit: () => void }) {
  const t = useT();
  const step = (d: number) => onScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((scale + d) * 10) / 10)));
  return (
    <span className="flex items-center">
      <button type="button" aria-label={t("ai.zoomOut")} title={t("ai.zoomOut")} onClick={() => step(-0.1)} disabled={scale <= MIN_SCALE} className="icon-btn h-8 w-8 text-muted">
        <Icon name="minus" size={15} />
      </button>
      <button type="button" onClick={onFit} title={t("ai.zoomFit")} className="h-8 min-w-[44px] rounded-lg px-1 text-xs tabular-nums text-muted hover:bg-soft hover:text-ink">
        {Math.round(scale * 100)}%
      </button>
      <button type="button" aria-label={t("ai.zoomIn")} title={t("ai.zoomIn")} onClick={() => step(0.1)} disabled={scale >= MAX_SCALE} className="icon-btn h-8 w-8 text-muted">
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
}: {
  docId: string;
  artifactId: string;
  nodes: MapNode[];
  node: MapNode | null;
  sources: Map<number, ChatCitation>;
  onOpen: (c: ChatCitation) => void;
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
  const { nodes, citations } = artifact.payload;
  const [collapsed, setCollapsed] = useState(() => initiallyCollapsed(nodes));
  const [selected, setSelected] = useState<string | null>(null);
  const [scale, setScale] = useState(0.8);
  const [largeScale, setLargeScale] = useState(1);
  const [large, setLarge] = useState(false);
  const small = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLDivElement>(null);
  const dialog = useModal(large);
  useTouchZoom(small, scale, setScale, MIN_SCALE, MAX_SCALE);
  // The dialog canvas mounts when opened; bind its gesture through a mounted child below.


  const layout = useMemo(() => layoutMindMap(nodes, collapsed), [nodes, collapsed]);
  const sources = useMemo(() => new Map(citations.map((c) => [c.position, c])), [citations]);
  const foldable = useMemo(() => {
    const parents = new Set(nodes.map((n) => n.parent));
    return nodes.filter((n) => n.parent !== null && parents.has(n.id)).map((n) => n.id);
  }, [nodes]);
  const node = nodes.find((n) => n.id === selected) ?? null;
  const unsourced = nodes.filter((n) => n.parent !== null && n.sources.length === 0).length;

  function toggle(id: string) {
    setCollapsed((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function fit(box: HTMLDivElement | null, set: (s: number) => void) {
    if (!box) return;
    const natural = layout.width + MARGIN * 2 + TOGGLE_R;
    set(Math.min(1, Math.max(MIN_SCALE, Math.floor(((box.clientWidth - 2) / natural) * 20) / 20)));
  }

  const fold = (
    <>
      <button type="button" onClick={() => setCollapsed(new Set())} disabled={collapsed.size === 0} className="h-8 rounded-lg px-2 text-[13px] text-muted hover:bg-soft hover:text-ink disabled:opacity-40">
        {t("ai.mapOpenAll")}
      </button>
      <button type="button" onClick={() => setCollapsed(new Set(foldable))} disabled={foldable.every((id) => collapsed.has(id))} className="h-8 rounded-lg px-2 text-[13px] text-muted hover:bg-soft hover:text-ink disabled:opacity-40">
        {t("ai.mapFoldAll")}
      </button>
    </>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-1">
        <Zoom scale={scale} onScale={setScale} onFit={() => fit(small.current, setScale)} />
        {fold}
        <span className="flex-1" />
        <button type="button" onClick={() => setLarge(true)} className="h-8 rounded-lg px-2 text-[13px] font-medium text-accent-text hover:bg-soft">
          {t("ai.mapEnlarge")}
        </button>
      </div>
      <div ref={small} className="max-h-[440px] overflow-auto rounded-xl border border-line bg-bg">
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
        className="dialog mobile-map w-[min(calc(100vw-32px),1180px)]"
      >
        {large && (
          <div className="flex max-h-[calc(100vh-34px)] flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center gap-x-1">
              <h2 className="mr-3 font-serif text-xl font-medium">{nodes[0]?.label}</h2>
              <Zoom scale={largeScale} onScale={setLargeScale} onFit={() => fit(big.current, setLargeScale)} />
              {fold}
              <span className="flex-1" />
              <button type="button" aria-label={t("common.close")} onClick={() => setLarge(false)} className="icon-btn h-9 w-9 text-muted">
                <Icon name="x" size={18} />
              </button>
            </div>
            <ZoomCanvas boxRef={big} scale={largeScale} onScale={setLargeScale}>
              <MapCanvas layout={layout} scale={largeScale} selected={selected} onSelect={setSelected} onToggle={toggle} />
            </ZoomCanvas>
            <NodeCard
              docId={docId}
              artifactId={artifact.id}
              nodes={nodes}
              node={node}
              sources={sources}
              onOpen={(c) => {
                setLarge(false); // the passage opens in the document behind the dialog
                onOpen(c);
              }}
            />
          </div>
        )}
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
