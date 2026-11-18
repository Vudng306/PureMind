"use client";

import { useState } from "react";

import { DayBars, StatCard as Stat } from "@/components/admin-parts";
import { Alert, Spinner } from "@/components/ui";
import { AREAS, useTraffic, type TrafficRange } from "@/lib/admin-content";
import { useLang, useT, type Key } from "@/lib/i18n";
import type { Lang } from "@/lib/types";

const RANGES: TrafficRange[] = [7, 30, 90];

function number(n: number, lang: Lang) {
  return n.toLocaleString(lang === "en" ? "en-GB" : "vi-VN");
}

/** How much PureMind is used: counts per day and part of the app, never who asked for what. */
export default function AdminTrafficPage() {
  const t = useT();
  const lang = useLang();
  const [days, setDays] = useState<TrafficRange>(30);
  const { data, error, isPending, isFetching } = useTraffic(days);

  if (error) return <Alert>{error.message}</Alert>;
  if (isPending) return <Spinner />;

  const { totals } = data;
  const n = (v: number) => number(v, lang);
  const errorRate = totals.requests ? `${((totals.errors / totals.requests) * 100).toFixed(totals.errors ? 2 : 0)}%` : "0%";
  const areaTotal = data.areas.reduce((sum, a) => sum + a.requests, 0);
  const dayList = data.days.map((d) => d.day);

  return (
    <section className={`flex flex-col gap-6 transition-opacity ${isFetching ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[28px] font-semibold tracking-[-0.01em]">{t("admin.tabTraffic")}</h2>
        <div role="group" aria-label={t("traffic.range")} className="segmented">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>
              {t("traffic.days", { n: r })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("traffic.users")} value={n(totals.users)} sub={t("traffic.activeToday", { n: n(totals.active_today) })} />
        <Stat label={t("traffic.signups")} value={n(totals.signups)} sub={t("traffic.inRange", { n: days })} />
        <Stat label={t("traffic.requests")} value={n(totals.requests)} sub={t("traffic.inRange", { n: days })} />
        <Stat
          label={t("traffic.errors")}
          value={n(totals.errors)}
          sub={t("traffic.errorRate", { rate: errorRate })}
          alert={totals.errors > 0}
        />
        <Stat label={t("traffic.libraryDocs")} value={n(totals.documents)} sub={t("traffic.allLibraries")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DayBars title={t("traffic.chartRequests")} days={dayList} values={data.days.map((d) => d.requests)} format={n} />
        <DayBars title={t("traffic.chartActive")} days={dayList} values={data.days.map((d) => d.active_users)} format={n} />
        <DayBars title={t("traffic.chartAi")} days={dayList} values={data.days.map((d) => d.ai_calls)} format={n} />
        <DayBars title={t("traffic.chartSignups")} days={dayList} values={data.days.map((d) => d.signups)} format={n} />
      </div>

      <div className="card overflow-x-auto">
        <h3 className="px-5 pb-2 pt-5 text-[15px] font-semibold text-ink">{t("traffic.byArea")}</h3>
        {data.areas.length === 0 ? (
          <p className="px-5 pb-6 text-sm text-muted">{t("traffic.empty")}</p>
        ) : (
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead className="border-b border-line">
              <tr>
                {(["traffic.colArea", "traffic.colRequests", "traffic.colShare", "traffic.colErrors", "traffic.colAi"] as const).map((k, i) => (
                  <th key={k} className={`px-5 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-muted ${i === 0 || i === 2 ? "text-left" : "text-right"}`}>
                    {t(k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.areas.map((a) => {
                const share = areaTotal ? a.requests / areaTotal : 0;
                return (
                  <tr key={a.area} className="border-b border-line last:border-0">
                    <td className="px-5 py-3 text-ink">{(AREAS as readonly string[]).includes(a.area) ? t(`area.${a.area}` as Key) : a.area}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-ink">{n(a.requests)}</td>
                    <td className="w-[34%] px-5 py-3">
                      <span className="flex items-center gap-2">
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-soft">
                          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(share * 100, a.requests ? 1 : 0)}%` }} />
                        </span>
                        <span className="w-11 text-right text-xs tabular-nums text-muted">{(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</span>
                      </span>
                    </td>
                    <td className={`px-5 py-3 text-right tabular-nums ${a.errors ? "font-semibold text-danger" : "text-muted"}`}>{n(a.errors)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-body">{n(a.ai_calls)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-[13px] leading-normal text-muted">{t("traffic.note")}</p>
    </section>
  );
}

