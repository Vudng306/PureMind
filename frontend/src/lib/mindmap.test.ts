import { describe, expect, it } from "vitest";

import { NODE_W, ROW_GAP, edgePath, initiallyCollapsed, layoutMindMap, pathTo, scrollToShow, wrapLabel } from "./mindmap";
import type { MapNode } from "./reader-ai";

const node = (id: string, parent: string | null, depth: number, label = id): MapNode => ({
  id,
  parent,
  label,
  detail: "",
  sources: [],
  depth,
});

// root → a (a1, a2), b (b1 → b1x)
const TREE: MapNode[] = [
  node("root", null, 0),
  node("a", "root", 1),
  node("a1", "a", 2),
  node("a2", "a", 2),
  node("b", "root", 1),
  node("b1", "b", 2),
  node("b1x", "b1", 3),
];

describe("wrapLabel", () => {
  it("keeps a short label on one line", () => {
    expect(wrapLabel("Học máy")).toEqual(["Học máy"]);
  });

  it("breaks at spaces and ends the last kept line with an ellipsis", () => {
    const lines = wrapLabel("một hai ba bốn năm sáu bảy tám chín mười mười một mười hai", 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBeLessThanOrEqual(10);
    expect(lines[1].endsWith("…")).toBe(true);
  });

  it("cuts a single word that is far too long", () => {
    const [line] = wrapLabel("x".repeat(80), 10, 3);
    expect(line.length).toBeLessThanOrEqual(14);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("layoutMindMap", () => {
  it("gives an empty layout when there is no root", () => {
    expect(layoutMindMap([node("a", "x", 1)], new Set())).toEqual({ placed: [], edges: [], width: 0, height: 0 });
  });

  it("puts each level in its own column and a parent between its children", () => {
    const { placed, edges } = layoutMindMap(TREE, new Set());
    const at = (id: string) => placed.find((p) => p.node.id === id)!;
    expect(placed).toHaveLength(TREE.length);
    expect(edges).toHaveLength(TREE.length - 1);
    expect(at("root").x).toBe(0);
    expect(at("a").x).toBe(at("b").x);
    expect(at("a1").x).toBeGreaterThan(at("a").x + NODE_W - 1);
    const mid = (id: string) => at(id).y + at(id).h / 2;
    expect(mid("a")).toBeCloseTo((mid("a1") + mid("a2")) / 2);
    expect(mid("root")).toBeCloseTo((mid("a") + mid("b")) / 2);
  });

  it("never lets two boxes of a column overlap", () => {
    // A long label makes a parent taller than the single child under it.
    const tall = [
      node("root", null, 0),
      node("a", "root", 1, "một nhãn rất dài để hộp cao hơn hẳn nhánh con ở bên dưới nó trong sơ đồ"),
      node("a1", "a", 2),
      node("b", "root", 1, "một nhãn rất dài khác cũng làm cho hộp này cao hơn nhánh con của nó"),
      node("b1", "b", 2),
    ];
    const { placed } = layoutMindMap(tall, new Set());
    for (const p of placed) {
      for (const other of placed) {
        if (p === other || p.x !== other.x || other.y < p.y) continue;
        expect(other.y).toBeGreaterThanOrEqual(p.y + p.h + ROW_GAP - 0.001);
      }
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("hides the branch of a folded node but still counts its children", () => {
    const { placed, edges } = layoutMindMap(TREE, new Set(["a"]));
    const ids = placed.map((p) => p.node.id);
    expect(ids).not.toContain("a1");
    expect(ids).not.toContain("a2");
    const a = placed.find((p) => p.node.id === "a")!;
    expect(a.collapsed).toBe(true);
    expect(a.children).toBe(2);
    expect(edges.some((e) => e.from.node.id === "a")).toBe(false);
  });

  it("does not loop on a node that names itself or an ancestor as its parent", () => {
    const loop = [node("root", null, 0), node("a", "root", 1), node("b", "a", 2), { ...node("a", "b", 3) }];
    const { placed } = layoutMindMap(loop, new Set());
    expect(placed.map((p) => p.node.id)).toEqual(["root", "a", "b"]);
  });

  it("draws an edge from the right of the parent to the left of the child", () => {
    const { edges } = layoutMindMap(TREE, new Set());
    const e = edges[0];
    expect(edgePath(e).startsWith(`M${e.from.x + e.from.w},`)).toBe(true);
    expect(edgePath(e)).toContain(` ${e.to.x},`);
  });
});

describe("initiallyCollapsed and pathTo", () => {
  it("folds only the deep nodes that have children", () => {
    expect([...initiallyCollapsed(TREE)]).toEqual(["b1"]);
  });

  it("gives the ancestors root first, and nothing for an unknown node", () => {
    expect(pathTo(TREE, "b1x").map((n) => n.id)).toEqual(["root", "b", "b1", "b1x"]);
    expect(pathTo(TREE, "nope")).toEqual([]);
  });
});

describe("scrollToShow", () => {
  const view = { left: 100, top: 200, width: 300, height: 400 };

  it("leaves the map alone when the box is in view", () => {
    expect(scrollToShow(view, { x: 150, y: 300, w: 100, h: 40 })).toEqual({ left: 100, top: 200 });
  });

  it("moves only the axis on which the box is hidden", () => {
    expect(scrollToShow(view, { x: 150, y: 900, w: 100, h: 40 })).toEqual({ left: 100, top: 720 });
    expect(scrollToShow(view, { x: 500, y: 300, w: 100, h: 40 })).toEqual({ left: 488, top: 200 });
  });

  it("stops at the start of the map", () => {
    expect(scrollToShow(view, { x: 4, y: 10, w: 100, h: 40 })).toEqual({ left: 0, top: 0 });
  });
});
