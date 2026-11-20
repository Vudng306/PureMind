import type { MapNode } from "./reader-ai";

/** Layout of a mind map as a tree that grows to the right: the root on the left, each level a column, a
 * parent centred on its children. Pure geometry, so the drawing itself is a plain SVG. */

export const NODE_W = 168;
export const COL_GAP = 44;
export const ROW_GAP = 10;
export const LINE_H = 17;
export const PAD_Y = 9;
const CHARS_PER_LINE = 22;
const MAX_LINES = 3;

export interface Placed {
  node: MapNode;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  /** How many children the node has, shown or not. */
  children: number;
  collapsed: boolean;
}

export interface Edge {
  from: Placed;
  to: Placed;
}

export interface MapLayout {
  placed: Placed[];
  edges: Edge[];
  width: number;
  height: number;
}

/** Break a label into lines of about `max` characters, at most `lines` of them (the last ends in an ellipsis). */
export function wrapLabel(label: string, max = CHARS_PER_LINE, lines = MAX_LINES): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of label.trim().split(/\s+/)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= max) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  const cut = out.map((line) => (line.length > max + 4 ? `${line.slice(0, max + 3)}…` : line));
  if (cut.length <= lines) return cut;
  const kept = cut.slice(0, lines);
  kept[lines - 1] = `${kept[lines - 1].replace(/[\s.,;:…]+$/, "")}…`;
  return kept;
}

/** The nodes that hang from the root, parents before children. A map with no root gives an empty layout. */
export function layoutMindMap(nodes: MapNode[], collapsed: ReadonlySet<string>): MapLayout {
  const children = new Map<string, MapNode[]>();
  for (const n of nodes) {
    if (n.parent === null) continue;
    const list = children.get(n.parent);
    if (list) list.push(n);
    else children.set(n.parent, [n]);
  }
  const root = nodes.find((n) => n.parent === null);
  const placed: Placed[] = [];
  const edges: Edge[] = [];
  if (!root) return { placed, edges, width: 0, height: 0 };

  let cursor = 0; // the next free y for a leaf
  const floor = new Map<number, number>(); // per column: where the next box may start
  const seen = new Set<string>();

  function place(node: MapNode, depth: number): Placed {
    seen.add(node.id);
    const start = placed.length;
    const lines = wrapLabel(node.label);
    const kids = (children.get(node.id) ?? []).filter((k) => !seen.has(k.id));
    const isCollapsed = collapsed.has(node.id);
    const item: Placed = {
      node,
      x: depth * (NODE_W + COL_GAP),
      y: 0,
      w: NODE_W,
      h: lines.length * LINE_H + PAD_Y * 2,
      lines,
      children: kids.length,
      collapsed: isCollapsed && kids.length > 0,
    };
    placed.push(item);
    const shown = isCollapsed ? [] : kids.map((k) => place(k, depth + 1));
    if (shown.length === 0) {
      item.y = cursor;
      cursor += item.h + ROW_GAP;
    } else {
      const first = shown[0];
      const last = shown[shown.length - 1];
      const centre = (first.y + first.h / 2 + last.y + last.h / 2) / 2;
      item.y = centre - item.h / 2;
      for (const child of shown) edges.push({ from: item, to: child });
    }
    // A box taller than the branch under it would run into the box above it in its column: the whole
    // branch moves down instead.
    const min = floor.get(depth) ?? 0;
    if (item.y < min) {
      const delta = min - item.y;
      for (let i = start; i < placed.length; i++) placed[i].y += delta;
      cursor += delta;
      for (const [column, y] of floor) if (column > depth) floor.set(column, y + delta);
    }
    floor.set(depth, item.y + item.h + ROW_GAP);
    return item;
  }

  place(root, 0);
  return {
    placed,
    edges,
    width: Math.max(...placed.map((p) => p.x + p.w)),
    height: Math.max(...placed.map((p) => p.y + p.h)),
  };
}

/** A smooth connector from the right edge of a parent to the left edge of a child. */
export function edgePath({ from, to }: Edge): string {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}

/** Nodes folded when the map first opens: everything below the points, so the first view fits a sidebar. */
export function initiallyCollapsed(nodes: MapNode[]): Set<string> {
  const parents = new Set(nodes.map((n) => n.parent));
  return new Set(nodes.filter((n) => n.depth >= 2 && parents.has(n.id)).map((n) => n.id));
}

/** A node with its ancestors, root first. */
export function pathTo(nodes: MapNode[], id: string): MapNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const path: MapNode[] = [];
  let node = byId.get(id);
  while (node && path.length < 8) {
    path.unshift(node);
    node = node.parent ? byId.get(node.parent) : undefined;
  }
  return path;
}

/** Where a scroller goes to show a box. An axis on which the box is already in view does not move, so what was just
 * tapped stays under the finger; otherwise the box comes to the leading edge (across) or the middle (down). */
export function scrollToShow(
  view: { left: number; top: number; width: number; height: number },
  box: { x: number; y: number; w: number; h: number },
  pad = 12,
): { left: number; top: number } {
  const seenAcross = box.x >= view.left + pad && box.x + box.w <= view.left + view.width - pad;
  const seenDown = box.y >= view.top + pad && box.y + box.h <= view.top + view.height - pad;
  return {
    left: seenAcross ? view.left : Math.max(0, box.x - pad),
    top: seenDown ? view.top : Math.max(0, box.y + box.h / 2 - view.height / 2),
  };
}
