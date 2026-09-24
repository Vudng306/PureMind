import { describe, expect, it } from "vitest";

import { chartCsv, sourceBoxes } from "./documents";
import { parseMarkdown } from "./markdown";

describe("sourceBoxes", () => {
  it("gives a repeated block the id the reader gives it", () => {
    const blocks = parseMarkdown(["Same.", "", "Other.", "", "Same."].join(String.fromCharCode(10)));
    const [same, other] = [blocks[0].id.slice(1), blocks[1].id.slice(1)];
    const map = sourceBoxes([
      [same, [[1, 0.1, 0.2, 0.3, 0.05]]],
      [other, [[1, 0.1, 0.3, 0.3, 0.05]]],
      [same, [[2, 0, 0, 1, 0.1], [3, 0, 0, 1, 0.1]]],
    ]);
    expect(map.get(blocks[0].id)).toEqual([{ page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.05 }]);
    expect(map.get(blocks[2].id)?.map((b) => b.page)).toEqual([2, 3]);
    expect([...map.keys()]).toEqual(blocks.map((b) => b.id));
  });
});

describe("chartCsv", () => {
  it("writes a row per point under the axes' titles, quoting what needs it", () => {
    const csv = chartCsv({
      title: "(a)",
      x: { title: "Suction, s (kPa)", scale: "log" },
      y: { title: "", scale: "linear" },
      series: [
        { name: 'ρd = 1.5 "dense"', color: "#ff0000", points: [[0.1, 2], [10, 3.5]] },
        { name: "", color: "#0000ff", points: [[1, -4]] },
      ],
    });
    expect(csv.split(String.fromCharCode(10))).toEqual([
      'series,"Suction, s (kPa)",y',
      '"ρd = 1.5 ""dense""",0.1,2',
      '"ρd = 1.5 ""dense""",10,3.5',
      "2,1,-4",
      "",
    ]);
  });
});
