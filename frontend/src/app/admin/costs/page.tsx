"use client";

import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";

import { DayBars, Pager, StatCard } from "@/components/admin-parts";
import { Icon } from "@/components/icons";
import { Alert, Spinner } from "@/components/ui";
import { formatDateTime } from "@/lib/admin";
import type { TrafficRange } from "@/lib/admin-content";
import { formatUsd, purposeLabel, useAiCosts, useAiRequests, type AiRequest, type Spend } from "@/lib/admin-costs";
import { formatDate } from "@/lib/documents";
import { useLang, useT } from "@/lib/i18n";

const RANGES: TrafficRange[] = [7, 30, 90];
const TH = "px-4 py-3 text-xs font-semibold uppercase tracking-[0.06em] text-muted";
const TD = "px-4 py-3 align-top";

function useNumber() {
  const lang = useLang();
  return (n: number) => n.toLocaleString(lang === "en" ? "en-GB" : "vi-VN");
}

/** What the AI costs: per day, feature, model and account, then request by request. Never what was asked. */
export default function AdminCostsPage() {
  const t = useT();
  const lang = useLang();
  const n = useNumber();
  const [days, setDays] = useState<TrafficRange>(30);
  const { data, error, isPending, isFetching } = useAiCosts(days);

  if (error) return <Alert>{error.message}</Alert>;
  if (isPending) return <Spinner />;

  const { totals, prices } = data;
  const usd = (v: number) => formatUsd(v, lang);
  const dayList = data.days.map((d) => d.day);

  return (
    <section className={`flex flex-col gap-6 transition-opacity ${isFetching ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-[28px] font-semibold tracking-[-0.01em]">{t("admin.tabCosts")}</h2>
        <div role="group" aria-label={t("traffic.range")} className="segmented">
          {RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={days === r} onClick={() => setDays(r)}>
              {t("traffic.days", { n: r })}
            </button>
          ))}
        </div>
      </div>

      {totals.unpriced_calls > 0 && <Alert>{t("cost.unpriced", { n: n(totals.unpriced_calls) })}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t("cost.total")} value={usd(totals.cost_usd)} sub={t("cost.today", { cost: usd(totals.today_cost_usd) })} />
        <StatCard
          label={t("cost.perRequest")}
          value={usd(totals.requests ? totals.cost_usd / totals.requests : 0)}
          sub={t("cost.requests", { n: n(totals.requests) })}
        />
        <StatCard
          label={t("cost.tokens")}
          value={n(totals.prompt_tokens + totals.completion_tokens)}
          sub={t("cost.tokensSub", { input: n(totals.prompt_tokens), output: n(totals.completion_tokens), cached: n(totals.cached_tokens) })}
        />
        <StatCard
          label={t("cost.calls")}
          value={n(totals.calls)}
          sub={t("cost.callsSub", { failed: n(totals.failed_calls), searches: n(totals.web_searches) })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DayBars title={t("cost.chartCost")} days={dayList} values={data.days.map((d) => d.cost_usd)} format={usd} />
        <DayBars title={t("cost.chartTokens")} days={dayList} values={data.days.map((d) => d.prompt_tokens + d.completion_tokens)} format={n} />
      </div>

      <SpendTable
        title={t("cost.byFeature")}
        first={t("cost.colFeature")}
        total={totals.cost_usd}
        rows={data.features.map((f) => ({ id: f.key, label: purposeLabel(f.key, t), spend: f }))}
      />
      <div className="grid items-start gap-4 2xl:grid-cols-2">
        <SpendTable
          title={t("cost.byModel")}
          first={t("cost.colModel")}
          total={totals.cost_usd}
          rows={data.models.map((m) => ({ id: m.key, label: m.key, spend: m }))}
        />
        <SpendTable
          title={t("cost.byUser")}
          first={t("cost.colUser")}
          total={totals.cost_usd}
          rows={data.users.map((u) => ({
            id: u.user_id,
            label: (
              <Link href={`/admin/users/${u.user_id}`} className="text-ink underline-offset-2 hover:underline">
                {u.email}
              </Link>
            ),
            spend: u,
          }))}
        />
      </div>

      <RequestList key={days} days={days} />

      <div className="card overflow-x-auto">
        <h3 className="px-5 pb-1 pt-5 text-[15px] font-semibold text-ink">{t("cost.prices")}</h3>
        <p className="px-5 pb-2 text-[13px] text-muted">
          {t("cost.pricesSub", { date: formatDate(`${prices.checked}T00:00:00`, lang), search: usd(prices.web_search_per_1k) })}
        </p>
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={`${TH} text-left`}>{t("cost.colModel")}</th>
              <th className={`${TH} text-right`}>{t("cost.colInput")}</th>
              <th className={`${TH} text-right`}>{t("cost.colCached")}</th>
              <th className={`${TH} text-right`}>{t("cost.colOutput")}</th>
            </tr>
          </thead>
          <tbody>
            {prices.models.map((m) => (
              <tr key={m.model} className="border-b border-line last:border-0">
                <td className={`${TD} text-ink`}>{m.model}</td>
                <td className={`${TD} text-right tabular-nums`}>{usd(m.input)}</td>
                <td className={`${TD} text-right tabular-nums`}>{usd(m.cached)}</td>
                <td className={`${TD} text-right tabular-nums`}>{m.output ? usd(m.output) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[13px] leading-normal text-muted">{t("cost.note")}</p>
    </section>
  );
}

function SpendTable({
  title,
  first,
  total,
  rows,
}: {
  title: string;
  first: string;
  total: number;
  rows: { id: string; label: ReactNode; spend: Spend }[];
}) {
  const t = useT();
  const lang = useLang();
  const n = useNumber();
  return (
    <div className="card overflow-x-auto">
      <h3 className="px-5 pb-2 pt-5 text-[15px] font-semibold text-ink">{title}</h3>
      {rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-muted">{t("cost.empty")}</p>
      ) : (
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={`${TH} text-left`}>{first}</th>
              <th className={`${TH} text-right`}>{t("cost.colCalls")}</th>
              <th className={`${TH} text-right`}>{t("cost.colInput")}</th>
              <th className={`${TH} text-right`}>{t("cost.colOutput")}</th>
              <th className={`${TH} text-right`}>{t("cost.colCost")}</th>
              <th className={`${TH} text-right`}>{t("traffic.colShare")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, label, spend }) => (
              <tr key={id} className="border-b border-line last:border-0">
                <td className={`${TD} text-ink`}>{label}</td>
                <td className={`${TD} text-right tabular-nums`}>{n(spend.calls)}</td>
                <td className={`${TD} text-right tabular-nums`}>{n(spend.prompt_tokens)}</td>
                <td className={`${TD} text-right tabular-nums`}>{n(spend.completion_tokens)}</td>
                <td className={`${TD} text-right font-semibold tabular-nums text-ink`}>{formatUsd(spend.cost_usd, lang)}</td>
                <td className={`${TD} text-right tabular-nums text-muted`}>{total ? `${((spend.cost_usd / total) * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RequestList({ days }: { days: TrafficRange }) {
  const t = useT();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isPending, isFetching } = useAiRequests(days, page);

  return (
    <div className="flex flex-col gap-3">
      <div className={`card relative overflow-x-auto transition-opacity ${isFetching ? "opacity-70" : ""}`}>
        <h3 className="px-5 pb-2 pt-5 text-[15px] font-semibold text-ink">{t("cost.byRequest")}</h3>
        {error ? (
          <div className="px-5 pb-5">
            <Alert>{error.message}</Alert>
          </div>
        ) : isPending ? (
          <div className="px-5 pb-5">
            <Spinner />
          </div>
        ) : data.items.length === 0 ? (
          <p className="px-5 pb-6 text-sm text-muted">{t("cost.empty")}</p>
        ) : (
          <table className="w-full min-w-[920px] border-collapse text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className={`${TH} text-left`}>{t("admin.colTime")}</th>
                <th className={`${TH} text-left`}>{t("cost.colUser")}</th>
                <th className={`${TH} text-left`}>{t("cost.colFeature")}</th>
                <th className={`${TH} text-right`}>{t("cost.colCalls")}</th>
                <th className={`${TH} text-right`}>{t("cost.colInput")}</th>
                <th className={`${TH} text-right`}>{t("cost.colOutput")}</th>
                <th className={`${TH} text-right`}>{t("cost.colCost")}</th>
                <th className={TH}>
                  <span className="sr-only">{t("cost.details")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => {
                const id = `${r.request_id}:${r.user_id ?? ""}`;
                return <RequestRow key={id} request={r} open={open === id} onToggle={() => setOpen(open === id ? null : id)} />;
              })}
            </tbody>
          </table>
        )}
      </div>
      <Pager data={data} onPage={setPage} />
    </div>
  );
}

function RequestRow({ request: r, open, onToggle }: { request: AiRequest; open: boolean; onToggle: () => void }) {
  const t = useT();
  const lang = useLang();
  const n = useNumber();
  const features = [...new Set(r.calls.map((c) => purposeLabel(c.purpose, t)))];
  const failed = r.calls.some((c) => !c.ok);

  return (
    <Fragment>
      <tr className="border-b border-line last:border-0">
        <td className={`${TD} whitespace-nowrap text-body`}>{formatDateTime(r.at, lang)}</td>
        <td className={TD}>
          {r.user_id ? (
            <Link href={`/admin/users/${r.user_id}`} className="text-ink underline-offset-2 hover:underline">
              {r.email}
            </Link>
          ) : (
            <span className="text-muted">{t("cost.noAccount")}</span>
          )}
        </td>
        <td className={`${TD} text-ink`}>{features.join(", ")}</td>
        <td className={`${TD} text-right tabular-nums ${failed ? "font-semibold text-danger" : ""}`}>{n(r.calls.length)}</td>
        <td className={`${TD} text-right tabular-nums`}>{n(r.prompt_tokens)}</td>
        <td className={`${TD} text-right tabular-nums`}>{n(r.completion_tokens)}</td>
        <td className={`${TD} text-right font-semibold tabular-nums text-ink`}>
          {formatUsd(r.cost_usd, lang)}
          {r.unpriced_calls > 0 && "*"}
        </td>
        <td className="px-2 py-1.5 text-right align-top">
          <button type="button" className="icon-btn" aria-expanded={open} aria-label={t("cost.details")} onClick={onToggle}>
            <span className={`inline-flex transition-transform ${open ? "rotate-90" : ""}`}>
              <Icon name="next" size={16} />
            </span>
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-soft last:border-0">
          <td colSpan={8} className="px-4 py-3">
            <p className="mb-2 break-all text-xs text-muted">{t("cost.requestId", { id: r.request_id })}</p>
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-3 font-medium">{t("cost.colFeature")}</th>
                  <th className="py-1 pr-3 font-medium">{t("cost.colModel")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("cost.colInput")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("cost.colCached")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("cost.colOutput")}</th>
                  <th className="py-1 pr-3 text-right font-medium">{t("cost.colDuration")}</th>
                  <th className="py-1 text-right font-medium">{t("cost.colCost")}</th>
                </tr>
              </thead>
              <tbody>
                {r.calls.map((c) => (
                  <tr key={c.id}>
                    <td className="py-1 pr-3 text-ink">
                      {purposeLabel(c.purpose, t)}
                      {!c.ok && <span className="ml-1.5 font-semibold text-danger">{t("cost.failed")}</span>}
                      {c.web_searches > 0 && <span className="ml-1.5 text-muted">{t("cost.searches", { n: c.web_searches })}</span>}
                    </td>
                    <td className="py-1 pr-3 text-body">{c.model}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(c.prompt_tokens)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(c.cached_tokens)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(c.completion_tokens)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{t("cost.seconds", { n: (c.duration_ms / 1000).toFixed(1) })}</td>
                    <td className="py-1 text-right tabular-nums text-ink">{c.cost_usd === null ? "—" : formatUsd(c.cost_usd, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
