"use client";

import { useState } from "react";

import { chartCsv, type Chart, type ChartAxis } from "@/lib/documents";
import { downloadText } from "@/lib/export";
import { useT } from "@/lib/i18n";

import { Icon } from "./icons";

/** The data points of a vector chart, read from the PDF's drawing: a table per series, per panel. */
export function ChartData({ chart }: { chart: Chart }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const panel = chart.panels[Math.min(index, chart.panels.length - 1)];
  if (!panel) return null;

  const axis = (name: string, a: ChartAxis) =>
    `${name}: ${a.title || name}${a.scale === "log" ? ` (${t("reader.chartLog")})` : ""}`;

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-3 text-left font-sans text-[13px] leading-normal">
      <div className="flex flex-wrap items-center gap-1.5">
        {chart.panels.length > 1 &&
          chart.panels.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === index}
              onClick={() => setIndex(i)}
              className="chip h-7 px-2.5 text-[12px]"
            >
              {p.title || t("reader.chartPanel", { n: i + 1 })}
            </button>
          ))}
        <button
          type="button"
          onClick={() =>
            downloadText(
              chartCsv(panel),
              `chart${chart.panels.length > 1 ? `-${index + 1}` : ""}.csv`,
              "text/csv;charset=utf-8",
            )
          }
          className="chip ml-auto h-7 px-2.5 text-[12px]"
        >
          <Icon name="download" size={13} className="text-accent" />
          {t("reader.chartCsv")}
        </button>
      </div>
      <p className="mt-2 text-muted">
        {axis("x", panel.x)} · {axis("y", panel.y)}
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {panel.series.map((s, i) => (
          <div key={i} className="min-w-0">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-ink">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="truncate">{s.name || t("reader.chartSeries", { n: i + 1 })}</span>
              <span className="ml-auto shrink-0 font-normal text-muted">
                {t("reader.chartPoints", { n: s.points.length })}
              </span>
            </div>
            <div className="max-h-48 overflow-auto rounded border border-line">
              <table className="w-full border-collapse tabular-nums">
                <thead className="sticky top-0 bg-soft">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">x</th>
                    <th className="px-2 py-1 text-left font-medium">y</th>
                  </tr>
                </thead>
                <tbody>
                  {s.points.map(([x, y], k) => (
                    <tr key={k} className="border-t border-line">
                      <td className="px-2 py-0.5">{x}</td>
                      <td className="px-2 py-0.5">{y}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted">{t("reader.chartDataNote")}</p>
    </div>
  );
}
