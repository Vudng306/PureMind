"use client";

import { useEffect, useState } from "react";

import { Pager, TopicPicker, TopicTags } from "@/components/admin-parts";
import { Icon } from "@/components/icons";
import { Alert, ConfirmDialog, Spinner } from "@/components/ui";
import { formatDateTime } from "@/lib/admin";
import {
  crawlApi,
  runTotals,
  useCrawl,
  useCrawlChange,
  useCrawlRuns,
  type Channel,
  type CrawlRun,
  type CrawlSource,
  type Schedule,
} from "@/lib/admin-content";
import { formatDate } from "@/lib/documents";
import type { Topic } from "@/lib/feed";
import { useLang, useT, type Key } from "@/lib/i18n";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** The crawler: when it runs by itself, the sources and their channels, and what each run brought. */
export default function AdminCrawlPage() {
  const t = useT();
  const { data, error, isPending } = useCrawl();
  const run = useCrawlChange(crawlApi.run);

  if (error) return <Alert>{error.message}</Alert>;
  if (isPending) return <Spinner />;

  const running = data.running;
  const names = Object.fromEntries(data.sources.map((s) => [s.id, s.name]));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-[28px] font-semibold tracking-[-0.01em]">{t("admin.tabCrawl")}</h2>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <ScheduleCard schedule={data.schedule} />
        <div className="card flex flex-col justify-between gap-4 p-5">
          <div className="flex flex-col gap-1.5">
            {running ? (
              <span role="status" className="flex items-center gap-2 text-[15px] font-semibold text-accent-text">
                <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" />
                {t("crawl.runningNow", { done: Object.keys(running.stats).length, total: running.sources.length })}
              </span>
            ) : (
              <span className="text-[15px] font-semibold text-ink">
                {data.last_run ? t("crawl.lastRun", { time: formatDateTime(data.last_run.started_at) }) : t("crawl.neverRun")}
              </span>
            )}
            {data.last_run && !running && <RunSummary run={data.last_run} />}
            <p className="text-[13px] leading-relaxed text-muted">{t("crawl.cutoff", { date: formatDate(data.cutoff) })}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary h-11 px-5" disabled={Boolean(running) || run.isPending} onClick={() => run.mutate(null)}>
              <Icon name="download" size={16} />
              {t("crawl.runAll")}
            </button>
            {run.error && <Alert>{run.error.message}</Alert>}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-[15px] font-semibold text-ink">{t("crawl.sourcesTitle")}</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          {data.sources.map((s) => (
            <SourceCard key={s.id} source={s} busy={Boolean(running) || run.isPending} onRun={() => run.mutate([s.id])} />
          ))}
        </div>
      </div>

      <Runs names={names} live={Boolean(running)} />
    </section>
  );
}

function ScheduleCard({ schedule }: { schedule: Schedule }) {
  const t = useT();
  const [draft, setDraft] = useState(schedule);
  const save = useCrawlChange(crawlApi.schedule);
  useEffect(() => setDraft(schedule), [schedule]);
  const changed = draft.enabled !== schedule.enabled || draft.hour !== schedule.hour;

  return (
    <form
      className="card flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft);
      }}
    >
      <h3 className="text-[15px] font-semibold text-ink">{t("crawl.scheduleTitle")}</h3>
      <label className="flex items-center gap-3 text-sm text-ink">
        <input type="checkbox" className="h-5 w-5 accent-[rgb(var(--accent))]" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        {t("crawl.scheduleEnabled")}
      </label>
      <label className="flex flex-wrap items-center gap-3 text-sm text-body">
        {t("crawl.hour")}
        <select
          value={draft.hour}
          disabled={!draft.enabled}
          onChange={(e) => setDraft({ ...draft, hour: Number(e.target.value) })}
          className="h-10 rounded-full border border-field bg-surface pl-3.5 pr-8 text-sm text-ink outline-none focus:border-focus disabled:opacity-50"
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, "0")}:00
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-outline h-10 px-4" disabled={!changed || save.isPending}>
          {t("common.save")}
        </button>
        {save.isSuccess && !changed && <span className="text-sm text-success">{t("crawl.saved")}</span>}
        {save.error && <Alert>{save.error.message}</Alert>}
      </div>
    </form>
  );
}

function SourceCard({ source, busy, onRun }: { source: CrawlSource; busy: boolean; onRun: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const toggle = useCrawlChange(crawlApi.source);
  const on = source.channels.filter((c) => c.enabled).length;

  return (
    <article className={`card flex flex-col gap-4 p-5 ${source.enabled ? "" : "opacity-80"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h4 className="font-display text-xl font-semibold">{source.name}</h4>
          <span className="text-[13px] text-muted">
            {t("crawl.articles", { n: source.article_count })} · {source.hosts[0]}
            {source.channel && ` · ${t("crawl.channelCount", { on, n: source.channels.length })}`}
          </span>
        </div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-body">
          <input
            type="checkbox"
            className="h-5 w-5 accent-[rgb(var(--accent))]"
            checked={source.enabled}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate({ id: source.id, enabled: e.target.checked })}
          />
          {t("crawl.sourceEnabled")}
        </label>
      </div>

      {source.channel === null ? (
        <p className="text-[13px] text-muted">{t("crawl.noChannels")}</p>
      ) : on === 0 ? (
        <p className="text-[13px] font-medium text-danger">{t("crawl.emptyChannels")}</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-outline h-9 px-3 text-[13px]" disabled={busy} onClick={onRun}>
          {t("crawl.runOne")}
        </button>
        {source.channel && (
          <button type="button" className="btn-ghost h-9 px-3 text-[13px]" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name={open ? "up" : "down"} size={14} />
            {t(open ? "crawl.hideChannels" : "crawl.showChannels")}
          </button>
        )}
      </div>
      {toggle.error && <Alert>{toggle.error.message}</Alert>}

      {open && source.channel && (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <ul className="flex flex-col divide-y divide-line">
            {source.channels.map((c) => (
              <ChannelRow key={c.id} channel={c} />
            ))}
          </ul>
          <AddChannel source={source} />
        </div>
      )}
    </article>
  );
}

function ChannelRow({ channel }: { channel: Channel }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [topics, setTopics] = useState<Topic[]>(channel.topics);
  const [confirm, setConfirm] = useState(false);
  const update = useCrawlChange(crawlApi.updateChannel);
  const remove = useCrawlChange(crawlApi.deleteChannel);

  return (
    <li className="flex flex-col gap-2 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2.5">
          <input
            type="checkbox"
            aria-label={t("crawl.channelOn")}
            className="h-4 w-4 shrink-0 accent-[rgb(var(--accent))]"
            checked={channel.enabled}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ id: channel.id, enabled: e.target.checked })}
          />
          <code className={`truncate text-[13px] ${channel.enabled ? "text-ink" : "text-muted line-through"}`}>{channel.key}</code>
        </label>
        {!editing && <TopicTags topics={channel.topics} />}
        <button type="button" className="icon-btn h-8 w-8" aria-label={t("crawl.editTopics")} title={t("crawl.editTopics")} onClick={() => setEditing(!editing)}>
          <Icon name="pencil" size={14} />
        </button>
        <button type="button" className="icon-btn h-8 w-8 text-danger" aria-label={t("crawl.deleteChannel")} title={t("crawl.deleteChannel")} onClick={() => setConfirm(true)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {editing && (
        <div className="flex flex-col gap-2 pl-6">
          <TopicPicker value={topics} onChange={setTopics} label={t("crawl.channelTopics")} />
          <button
            type="button"
            className="btn-outline h-9 self-start px-3 text-[13px]"
            disabled={!topics.length || update.isPending}
            onClick={() => update.mutate({ id: channel.id, topics }, { onSuccess: () => setEditing(false) })}
          >
            {t("crawl.saveTopics")}
          </button>
        </div>
      )}
      {(update.error || remove.error) && <Alert>{(update.error ?? remove.error)?.message}</Alert>}
      <ConfirmDialog
        open={confirm}
        title={t("crawl.deleteChannel")}
        confirmLabel={t("crawl.deleteChannel")}
        cancelLabel={t("common.cancel")}
        busy={remove.isPending}
        onConfirm={() => remove.mutate(channel.id, { onSettled: () => setConfirm(false) })}
        onCancel={() => setConfirm(false)}
      >
        {t("crawl.deleteChannelConfirm", { key: channel.key })}
      </ConfirmDialog>
    </li>
  );
}

function AddChannel({ source }: { source: CrawlSource }) {
  const t = useT();
  const [key, setKey] = useState("");
  const [topics, setTopics] = useState<Topic[]>([]);
  const add = useCrawlChange(crawlApi.addChannel);

  return (
    <form
      className="flex flex-col gap-2.5 rounded-2xl bg-soft p-4"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(
          { source: source.id, key: key.trim(), topics },
          {
            onSuccess: () => {
              setKey("");
              setTopics([]);
            },
          },
        );
      }}
    >
      <label className="field-label">
        {t("crawl.addChannel")}
        <input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t(`crawl.kind.${source.channel}` as Key)} maxLength={300} />
      </label>
      <span className="text-[13px] font-medium text-body">{t("crawl.channelTopics")}</span>
      <TopicPicker value={topics} onChange={setTopics} label={t("crawl.channelTopics")} />
      <button type="submit" className="btn-primary h-10 self-start px-4" disabled={key.trim().length < 2 || !topics.length || add.isPending}>
        <Icon name="plus" size={16} />
        {t("crawl.addChannel")}
      </button>
      {add.error && <Alert>{add.error.message}</Alert>}
    </form>
  );
}

function RunSummary({ run }: { run: CrawlRun }) {
  const t = useT();
  const total = runTotals(run);
  return (
    <span className="text-sm tabular-nums text-body">
      <StatusBadge run={run} /> {t("crawl.result", total)}
    </span>
  );
}

const STATUS_CLS = {
  running: "bg-accent-soft text-accent-text",
  done: "bg-success-soft text-success",
  failed: "bg-danger-soft text-danger",
} as const;

function StatusBadge({ run }: { run: CrawlRun }) {
  const t = useT();
  return (
    <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ${STATUS_CLS[run.status]}`}>
      {t(`crawl.status.${run.status}` as Key)}
    </span>
  );
}

function Runs({ names, live }: { names: Record<string, string>; live: boolean }) {
  const t = useT();
  const lang = useLang();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isPending } = useCrawlRuns(page, live);

  const th = "px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted";
  const td = "px-4 py-3 align-top";

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold text-ink">{t("crawl.runsTitle")}</h3>
      {error ? (
        <Alert>{error.message}</Alert>
      ) : isPending ? (
        <Spinner />
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>{t("crawl.colStarted")}</th>
                  <th className={th}>{t("crawl.colTrigger")}</th>
                  <th className={th}>{t("crawl.colBy")}</th>
                  <th className={th}>{t("crawl.colResult")}</th>
                  <th className={`${th} text-right`}>{t("crawl.details")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <RunRow key={r.id} run={r} names={names} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} lang={lang} td={td} />
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted">
                      {t("crawl.noRuns")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pager data={data} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function RunRow({
  run,
  names,
  open,
  onToggle,
  lang,
  td,
}: {
  run: CrawlRun;
  names: Record<string, string>;
  open: boolean;
  onToggle: () => void;
  lang: ReturnType<typeof useLang>;
  td: string;
}) {
  const t = useT();
  return (
    <>
      <tr className="border-b border-line last:border-0">
        <td className={`${td} whitespace-nowrap tabular-nums text-body`}>{formatDateTime(run.started_at, lang)}</td>
        <td className={td}>
          <span className="flex flex-col gap-1">
            <span className="text-ink">{t(`crawl.trigger.${run.trigger}` as Key)}</span>
            <span className="text-xs text-muted">{run.sources.map((s) => names[s] ?? s).join(", ")}</span>
          </span>
        </td>
        <td className={`${td} text-body`}>{run.admin_email ?? t("admin.systemTarget")}</td>
        <td className={td}>
          <span className="flex flex-col gap-1">
            <RunSummary run={run} />
            {run.error && <span className="text-xs text-danger">{run.error}</span>}
          </span>
        </td>
        <td className={`${td} text-right`}>
          <button type="button" className="icon-btn h-8 w-8" aria-expanded={open} aria-label={t("crawl.details")} onClick={onToggle}>
            <Icon name={open ? "up" : "down"} size={14} />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-soft/60">
          <td colSpan={5} className="px-4 py-3">
            <ul className="flex flex-col gap-2">
              {Object.entries(run.stats).map(([source, s]) => (
                <li key={source} className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-semibold text-ink">{names[source] ?? source}</span>
                  <span className="text-[13px] tabular-nums text-body">{t("crawl.sourceResult", { ...s, error_messages: "" })}</span>
                  {s.error_messages?.map((m, i) => (
                    <code key={i} className="block truncate text-xs text-danger">
                      {m}
                    </code>
                  ))}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
