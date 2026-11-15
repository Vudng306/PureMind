"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { ApiError } from "@/lib/api";
import type { ChatCitation } from "@/lib/chat";
import { formatDate, useDocument } from "@/lib/documents";
import { useLang, useT, type Key } from "@/lib/i18n";
import { RESEARCH_ANALYSIS } from "@/lib/features";
import { MSG, messageFor } from "@/lib/messages";
import { useAccount } from "@/lib/queries";
import {
  ANALYSIS_FIELDS,
  DEEP_SECTIONS,
  RESEARCH_TYPES,
  findSnippet,
  useArtifact,
  useCreateArtifact,
  type AiLanguage,
  type AnalysisField,
  type AnalysisPayload,
  type Artifact,
  type ArtifactKind,
  type DeepPayload,
  type DeepSection,
  type Point,
  type QuickPayload,
} from "@/lib/reader-ai";

import { AiConsentDialog } from "./ai-consent-dialog";
import { AiBadge, AiCoverage, Cites, SaveToNotes } from "./cite";
import { Icon } from "./icons";
import { ConfirmDialog } from "./ui";

// A language's own name reads the same in both interfaces.
const LANGUAGES: ["vi" | "en", string][] = [
  ["vi", "Tiếng Việt"],
  ["en", "English"],
];

const COPY: Record<ArtifactKind, { empty: Key; lede: Key; create: Key }> = {
  quick: { empty: "ai.quickEmpty", lede: "ai.quickLede", create: "ai.quickCreate" },
  deep: { empty: "ai.deepEmpty", lede: "ai.deepLede", create: "ai.deepCreate" },
  mindmap: { empty: "ai.mapEmpty", lede: "ai.mapLede", create: "ai.mapCreate" },
  analysis: { empty: "ai.analysisEmpty", lede: "ai.analysisLede", create: "ai.analysisCreate" },
};

function Working({ replacing }: { replacing: boolean }) {
  const t = useT();
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-lg bg-soft px-3 py-2.5 text-sm text-muted">
      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" aria-hidden />
      {t(replacing ? "ai.replacing" : "ai.working")}
    </div>
  );
}

/**
 * What every AI result in the sidebar shares: nothing is made until the reader asks, the stored result opens
 * for free, a failure leaves the reader as it was with a way to try again, and a result made from an older
 * text says so.
 */
export function ArtifactFrame<K extends ArtifactKind>({
  docId,
  kind,
  children,
}: {
  docId: string;
  kind: K;
  children: (artifact: Artifact<K>) => React.ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const { data: doc } = useDocument(docId);
  const { data: user } = useAccount();
  const { data: artifact, isPending, isError, refetch } = useArtifact(docId, kind);
  const create = useCreateArtifact(docId, kind);
  // Written in the reader's own language unless they pick the other one.
  const [language, setLanguage] = useState<AiLanguage>(lang === "en" ? "en" : "vi");
  const [ask, setAsk] = useState<"consent" | "regenerate" | null>(null);

  const consented = Boolean(user?.reading_preferences.ai_consent);
  const quota = user?.ai_quota_remaining;
  const working = create.isPending;
  const noText = doc?.extraction_status === "failed" || (doc?.extraction_status === "done" && !doc.content_clean.trim());
  const extracting = doc?.extraction_status === "pending" || doc?.extraction_status === "processing";
  const error = create.error instanceof ApiError ? create.error.message : create.error ? MSG["MSG-99"] : null;
  const copy = COPY[kind];

  function start() {
    create.reset();
    if (!consented) return setAsk("consent");
    if (artifact) return setAsk("regenerate");
    create.mutate(language);
  }

  if (isPending) return <p className="text-sm text-muted">{t("ai.loading")}</p>;
  if (isError) {
    return (
      <p className="text-sm text-danger">
        {t("ai.loadFailed")}{" "}
        <button type="button" className="underline" onClick={() => void refetch()}>
          {t("common.retry")}
        </button>
      </p>
    );
  }

  const controls = (
    <div className="flex flex-col gap-3">
      <div className="split" role="group" aria-label={t("summary.language")}>
        {LANGUAGES.map(([value, name]) => (
          <button key={value} type="button" aria-pressed={language === value} onClick={() => setLanguage(value)} disabled={working}>
            {name}
          </button>
        ))}
      </div>
      <button
        type="button"
        className={`${artifact ? "btn-outline" : "btn-primary"} h-12 w-full justify-center text-[15px]`}
        onClick={start}
        disabled={working || noText || extracting || quota === 0}
      >
        <Icon name="spark" size={18} />
        {t(artifact ? "ai.recreate" : copy.create)}
      </button>
    </div>
  );

  // A refusal (422: not a study, too little text) would only be refused again, so it offers no retry.
  const final = create.error instanceof ApiError && create.error.status === 422;
  const failure = error && (
    <p className="text-sm text-danger" role="alert">
      {error}
      {!final && (
        <>
          {" "}
          <button type="button" className="underline" onClick={() => create.mutate(language)} disabled={working}>
            {t("common.retry")}
          </button>
        </>
      )}
    </p>
  );

  return (
    <div className="flex flex-col gap-5">
      {artifact ? (
        <>
          <div className="flex flex-col gap-3">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <AiBadge />
              {t("summary.madeAt", {
                date: formatDate(artifact.created_at, lang),
                time: new Date(artifact.created_at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" }),
              })}{" "}
              · {artifact.ai_model}
            </span>
            {controls}
          </div>
          {artifact.stale && !working && (
            <p className="rounded-lg bg-soft px-3 py-2.5 text-[13px] leading-normal text-body" role="status">
              {/* AI-107: another text is said first; an older prompt or model only dates the result. */}
              {t(artifact.stale_reason && artifact.stale_reason !== "content" ? "ai.staleRevision" : "ai.stale")}
            </p>
          )}
          <AiCoverage issues={doc?.extraction_issues} />
          {working && <Working replacing />}
          {failure}
          {children(artifact)}
          <p className="text-xs leading-normal text-muted">{t("ai.disclaimer")}</p>
        </>
      ) : (
        <div className="flex flex-col gap-4 rounded-2xl border border-line p-5">
          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-semibold leading-snug text-ink">{t(copy.empty)}</h3>
            <p className="text-[15px] leading-relaxed text-muted">{t(copy.lede)}</p>
          </div>
          {noText ? (
            <>
              <p className="text-sm leading-relaxed text-danger">
                {doc?.extraction_error ? messageFor(doc.extraction_error) : t("ai.needText")}
              </p>
              <Link href="/library" className="btn-outline h-10 self-start text-sm">
                <Icon name="upload" size={16} />
                {t("ai.uploadPdf")}
              </Link>
            </>
          ) : extracting ? (
            <p className="text-sm text-muted">{t("summary.extracting")}</p>
          ) : (
            controls
          )}
          {working && <Working replacing={false} />}
          {failure}
        </div>
      )}

      {quota !== undefined && (
        <span className={`text-sm ${quota === 0 ? "text-danger" : "text-muted"}`}>
          {quota === 0 ? MSG["MSG-25"] : t("summary.quota", { n: quota })}
        </span>
      )}

      <AiConsentDialog
        open={ask === "consent"}
        what={t("summary.consentWhat")}
        onAgreed={() => {
          setAsk(null);
          create.mutate(language);
        }}
        onCancel={() => setAsk(null)}
      />

      <ConfirmDialog
        open={ask === "regenerate"}
        title={t("ai.regenerateQ")}
        tone="primary"
        confirmLabel={t("ai.recreate")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => {
          setAsk(null);
          create.mutate(language);
        }}
        onCancel={() => setAsk(null)}
      >
        {t("ai.regenerateBody")}
      </ConfirmDialog>
    </div>
  );
}

function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="eyebrow flex items-center gap-2">
        {title}
        {badge}
      </h3>
      {children}
    </section>
  );
}

/** One point with its citations and its own "save to notes". */
function PointRow({
  docId,
  artifactId,
  part,
  point,
  sources,
  onOpen,
}: {
  docId: string;
  artifactId: string;
  part: string;
  point: Point;
  sources: Map<number, ChatCitation>;
  onOpen: (c: ChatCitation) => void;
}) {
  return (
    <li className="flex items-start gap-1">
      <span className="min-w-0 flex-1 font-serif text-[15px] leading-relaxed text-ink">
        {point.text}
        <Cites ns={point.sources} sources={sources} onOpen={onOpen} />
      </span>
      <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifactId, part }} compact />
    </li>
  );
}

function QuickView({
  docId,
  artifact,
  onOpen,
}: {
  docId: string;
  artifact: Artifact<"quick">;
  onOpen: (c: ChatCitation) => void;
}) {
  const t = useT();
  const lang = useLang();
  const p: QuickPayload = artifact.payload;
  const sources = useMemo(() => new Map(p.citations.map((c) => [c.position, c])), [p.citations]);
  return (
    <>
      <Section title="TL;DR">
        <ul className="flex flex-col">
          <PointRow
            docId={docId}
            artifactId={artifact.id}
            part="tldr"
            point={{ text: p.tldr, sources: p.tldr_sources }}
            sources={sources}
            onOpen={onOpen}
          />
        </ul>
      </Section>
      <Section title={t("ai.takeaways").toLocaleUpperCase(lang)}>
        <ul className="flex flex-col gap-2.5">
          {p.takeaways.map((point, i) => (
            <PointRow key={i} docId={docId} artifactId={artifact.id} part={`takeaway:${i}`} point={point} sources={sources} onOpen={onOpen} />
          ))}
        </ul>
      </Section>
      <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifact.id, part: "all" }} className="self-start" />
    </>
  );
}

const SECTION_TITLE: Record<DeepSection, Key> = {
  context: "ai.sectionContext",
  core: "ai.sectionCore",
  findings: "ai.sectionFindings",
  limitations: "ai.sectionLimitations",
};

function DeepView({
  docId,
  artifact,
  onOpen,
}: {
  docId: string;
  artifact: Artifact<"deep">;
  onOpen: (c: ChatCitation) => void;
}) {
  const t = useT();
  const lang = useLang();
  const p: DeepPayload = artifact.payload;
  const sources = useMemo(() => new Map(p.citations.map((c) => [c.position, c])), [p.citations]);
  return (
    <>
      {DEEP_SECTIONS.map((name) => {
        // A study has a method; anything else has arguments.
        const title = name === "core" && p.document_type === "research" ? "ai.sectionMethod" : SECTION_TITLE[name];
        return (
          <Section key={name} title={t(title).toLocaleUpperCase(lang)}>
            {p[name].length === 0 ? (
              <p className="text-sm text-muted">{t("ai.notStated")}</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {p[name].map((point, i) => (
                  <PointRow key={i} docId={docId} artifactId={artifact.id} part={`${name}:${i}`} point={point} sources={sources} onOpen={onOpen} />
                ))}
              </ul>
            )}
          </Section>
        );
      })}
      {p.questions.length > 0 && (
        <Section title={t("ai.sectionQuestions").toLocaleUpperCase(lang)} badge={<AiBadge label={t("ai.suggested")} />}>
          <ul className="flex flex-col gap-2">
            {p.questions.map((question, i) => (
              <li key={i} className="flex items-start gap-1">
                <span className="min-w-0 flex-1 text-[15px] leading-relaxed text-body">{question}</span>
                <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifact.id, part: `question:${i}` }} compact />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifact.id, part: "all" }} className="self-start" />
    </>
  );
}

const FIELD_TITLE: Record<AnalysisField, Key> = {
  question: "ai.fieldQuestion",
  method: "ai.fieldMethod",
  data: "ai.fieldData",
  findings: "ai.fieldFindings",
  limitations: "ai.fieldLimitations",
  applicability: "ai.fieldApplicability",
};

/** AI-111: what a study or a report reports, field by field; a field it does not report says so. */
function AnalysisView({
  docId,
  artifact,
  onOpen,
}: {
  docId: string;
  artifact: Artifact<"analysis">;
  onOpen: (c: ChatCitation) => void;
}) {
  const t = useT();
  const lang = useLang();
  const p: AnalysisPayload = artifact.payload;
  const sources = useMemo(() => new Map(p.citations.map((c) => [c.position, c])), [p.citations]);
  return (
    <>
      {ANALYSIS_FIELDS.map((name) => (
        <Section key={name} title={t(FIELD_TITLE[name]).toLocaleUpperCase(lang)}>
          {p[name].length === 0 ? (
            <p className="text-sm text-muted">{t("ai.notReported")}</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {p[name].map((point, i) => (
                <PointRow key={i} docId={docId} artifactId={artifact.id} part={`${name}:${i}`} point={point} sources={sources} onOpen={onOpen} />
              ))}
            </ul>
          )}
        </Section>
      ))}
      <SaveToNotes docId={docId} piece={{ source: "artifact", source_id: artifact.id, part: "all" }} className="self-start" />
    </>
  );
}

type SummaryMode = "quick" | "deep" | "analysis";

/** The reader's summary view: a quick one to decide, a deep one to study, and for a study or a report the
 * research analysis. Each is made only when asked for. */
export function AiSummaryPanel({ docId, onFind }: { docId: string; onFind: (text: string) => void }) {
  const t = useT();
  const [chosen, setMode] = useState<SummaryMode>("quick");
  // An essay is not forced into a research analysis: a deep summary that found another type hides it.
  const { data: deep } = useArtifact(docId, "deep", RESEARCH_ANALYSIS);
  const research = RESEARCH_ANALYSIS && (!deep || RESEARCH_TYPES.includes(deep.payload.document_type));
  const modes: SummaryMode[] = research ? ["quick", "deep", "analysis"] : ["quick", "deep"];
  const mode = modes.includes(chosen) ? chosen : "quick";
  const open = (c: ChatCitation) => onFind(findSnippet(c.text));
  return (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label={t("ai.modeAria")} className="flex shrink-0 self-start rounded-full bg-soft p-1">
        {modes.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={`h-10 rounded-full px-4 text-[15px] font-medium ${
              mode === value ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {t(value === "quick" ? "ai.modeQuick" : value === "deep" ? "ai.modeDeep" : "ai.modeAnalysis")}
          </button>
        ))}
      </div>
      {mode === "quick" ? (
        <ArtifactFrame key="quick" docId={docId} kind="quick">
          {(artifact) => <QuickView docId={docId} artifact={artifact} onOpen={open} />}
        </ArtifactFrame>
      ) : mode === "deep" ? (
        <ArtifactFrame key="deep" docId={docId} kind="deep">
          {(artifact) => <DeepView docId={docId} artifact={artifact} onOpen={open} />}
        </ArtifactFrame>
      ) : (
        <ArtifactFrame key="analysis" docId={docId} kind="analysis">
          {(artifact) => <AnalysisView docId={docId} artifact={artifact} onOpen={open} />}
        </ArtifactFrame>
      )}
    </div>
  );
}
