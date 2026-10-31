"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Spinner } from "@/components/ui";
import { useDocuments } from "@/lib/documents";
import { useLang } from "@/lib/i18n";
import { studyApi, type Attempt, type StudySet } from "@/lib/study";

export default function StudyPage() {
  const lang = useLang();
  const say = (vi: string, en: string) => lang === "vi" ? vi : en;
  const qc = useQueryClient();
  const sets = useQuery({ queryKey: ["study"], queryFn: studyApi.list });
  const docs = useDocuments("created_desc");
  const [documentId, setDocumentId] = useState("");
  const [kind, setKind] = useState<StudySet["kind"]>("flashcards");
  const [count, setCount] = useState(5);
  const [activeId, setActiveId] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const generate = useMutation({
    mutationFn: () => studyApi.generate(documentId, kind, count, lang),
    onSuccess: (set) => { setActiveId(set.id); void qc.invalidateQueries({ queryKey: ["study"] }); void qc.invalidateQueries({ queryKey: ["account"] }); },
  });
  const remove = useMutation({
    mutationFn: studyApi.remove,
    onSuccess: () => { setDeleteId(""); void qc.invalidateQueries({ queryKey: ["study"] }); },
  });
  const active = sets.data?.find(s => s.id === activeId);
  return <div className="mx-auto max-w-[1040px] space-y-7">
    <div><h1 className="font-serif text-4xl">{say("Ôn tập kiến thức", "Study & practice")}</h1>
      <p className="mt-3 text-muted">{say("Biến những gì bạn đọc thành kiến thức bạn nhớ.", "Turn what you read into knowledge you remember.")}</p></div>
    <form className="space-y-4 rounded-2xl border border-line bg-surface p-6" onSubmit={e => { e.preventDefault(); generate.mutate(); }}>
      <h2 className="text-xl font-semibold">{say("Tạo bộ ôn tập bằng AI", "Generate a study set with AI")}</h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-2">{say("Tài liệu", "Document")}<select required className="input w-full" value={documentId} onChange={e => setDocumentId(e.target.value)}>
          <option value="">{say("Chọn tài liệu", "Choose a document")}</option>
          {docs.data?.filter(d => d.extraction_status === "done").map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
        </select></label>
        <label className="space-y-2">{say("Hình thức", "Format")}<select className="input w-full" value={kind} onChange={e => setKind(e.target.value as StudySet["kind"])}>
          <option value="flashcards">{say("Flashcard từ highlight", "Flashcards from highlights")}</option><option value="quiz">{say("Trắc nghiệm từ tài liệu", "Document quiz")}</option>
        </select></label>
        <label className="space-y-2">{say("Số câu / thẻ", "Questions / cards")}<select className="input w-full" value={count} onChange={e => setCount(Number(e.target.value))}>{[3, 5, 10, 15].map(n => <option key={n}>{n}</option>)}</select></label>
      </div>
      <p className="text-sm text-muted">{say("Mỗi bộ dùng 1 lượt AI. Flashcard cần highlight có sẵn. AI có thể sai; hãy kiểm tra trích đoạn nguồn. Bạn có thể bật quyền gửi nội dung tới OpenAI trong Cài đặt.", "Each set uses 1 AI credit. Flashcards require existing highlights. AI can make mistakes; check source quotes. Enable OpenAI consent in Settings.")} <Link className="underline" href="/settings">{say("Cài đặt", "Settings")}</Link></p>
      <button className="btn-primary" disabled={!documentId || generate.isPending}>{generate.isPending ? say("Đang tạo…", "Generating…") : say("Tạo bộ ôn tập", "Generate set")}</button>
      {docs.isPending && <Spinner />}{docs.error && <Alert>{docs.error.message}</Alert>}
      {docs.isSuccess && !docs.data.length && <Link className="underline" href="/library">{say("Thêm tài liệu đầu tiên trong thư viện.", "Add your first document in the library.")}</Link>}
      {generate.error && <Alert>{generate.error.message}</Alert>}
    </form>
    {active && <StudySession key={active.id} set={active} close={() => setActiveId("")} />}
    <h2 className="text-xl font-semibold">{say("Bộ ôn tập của bạn", "Your study sets")}</h2>
    {sets.isPending && <Spinner />}{sets.error && <Alert>{sets.error.message}</Alert>}{remove.error && <Alert>{remove.error.message}</Alert>}
    {sets.isSuccess && !sets.data.length && <p className="rounded-xl border border-dashed border-line p-10 text-center text-muted">{say("Chưa có bộ ôn tập. Chọn tài liệu ở trên để bắt đầu.", "No study sets yet. Choose a document above to begin.")}</p>}
    <div className="grid gap-4 sm:grid-cols-2">{sets.data?.map(set => <article key={set.id} className="space-y-3 rounded-xl border border-line p-5">
      <span className="text-sm text-muted">{set.kind === "quiz" ? say("Trắc nghiệm", "Quiz") : "Flashcards"} · {set.items.length} {say("câu / thẻ", "items")}</span>
      <h3 className="text-lg font-semibold">{set.title}</h3>
      {set.kind === "flashcards" && <p className="text-sm text-muted">{set.items.filter((_, i) => !set.progress[i] || Date.parse(set.progress[i].due) <= Date.now()).length} {say("thẻ đến hạn ôn", "cards due")}</p>}
      <div className="flex flex-wrap gap-3"><button className="btn-primary" onClick={() => setActiveId(set.id)}>{say("Bắt đầu", "Start")}</button><Link className="btn-outline" href={`/reader/${set.document_id}`}>{say("Đọc nguồn", "Read source")}</Link>
        <button className="btn-outline" onClick={() => setDeleteId(set.id)}>{say("Xóa", "Delete")}</button></div>
      {deleteId === set.id && <div className="space-y-2"><p>{say("Xóa bộ ôn tập và toàn bộ lịch sử?", "Delete this set and its history?")}</p><button className="btn-outline" disabled={remove.isPending} onClick={() => remove.mutate(set.id)}>{say("Xác nhận xóa", "Confirm deletion")}</button> <button className="btn-outline" onClick={() => setDeleteId("")}>{say("Hủy", "Cancel")}</button></div>}
    </article>)}</div>
  </div>;
}

function StudySession({ set, close }: { set: StudySet; close: () => void }) {
  const lang = useLang();
  const say = (vi: string, en: string) => lang === "vi" ? vi : en;
  const qc = useQueryClient();
  const [index, setIndex] = useState(() => Math.max(0, set.items.findIndex((_, i) => !set.progress[i] || Date.parse(set.progress[i].due) <= Date.now())));
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState<number[]>([]);
  const [answers, setAnswers] = useState<number[]>([]);
  const [result, setResult] = useState<Attempt | null>(null);
  const history = useQuery({ queryKey: ["study-history", set.id], queryFn: () => studyApi.history(set.id), enabled: set.kind === "quiz" });
  const submit = useMutation({ mutationFn: () => studyApi.submit(set.id, answers), onSuccess: result => { setResult(result); void history.refetch(); } });
  const review = useMutation({ mutationFn: (remembered: boolean) => studyApi.review(set.id, index, remembered), onSuccess: () => {
    setReviewed(previous => [...previous, index]); setIndex(due.find(i => i !== index) ?? index); setRevealed(false); void qc.invalidateQueries({ queryKey: ["study"] });
  } });
  const due = set.items.map((_, i) => i).filter(i => !reviewed.includes(i) && (!set.progress[i] || Date.parse(set.progress[i].due) <= Date.now()));
  const current = set.items[index];
  return <section className="space-y-5 rounded-2xl border border-line bg-surface p-6">
    <div className="flex items-center justify-between gap-4"><h2 className="text-xl font-semibold">{set.title}</h2><button className="btn-outline" onClick={close}>{say("Đóng", "Close")}</button></div>
    {set.kind === "flashcards" ? <>
      {due.length === 0 ? <p role="status">{say("Đã ôn hết thẻ đến hạn. Hẹn bạn ở lần ôn tiếp theo!", "All due cards reviewed. See you next time!")}</p> : <>
        <p className="text-sm text-muted">{say("Thẻ", "Card")} {index + 1} / {set.items.length} · {due.length} {say("thẻ đến hạn", "due")}</p>
        <div className="space-y-5 rounded-xl bg-soft p-7"><p className="text-xl">{current.question}</p>
          {revealed ? <><p className="whitespace-pre-wrap">{current.answer}</p><blockquote className="border-l-2 border-accent pl-4 text-sm text-muted">{current.source}</blockquote></> : <button className="btn-outline" onClick={() => setRevealed(true)}>{say("Xem đáp án", "Reveal answer")}</button>}</div>
        {revealed && <div className="flex gap-3"><button className="btn-outline" disabled={review.isPending} onClick={() => review.mutate(false)}>{say("Chưa nhớ · ôn sau 10 phút", "Again · in 10 minutes")}</button><button className="btn-primary" disabled={review.isPending} onClick={() => review.mutate(true)}>{say("Đã nhớ · giãn lịch ôn", "Remembered · extend interval")}</button></div>}
        <button className="btn-outline" onClick={() => { setIndex(due.find(i => i !== index) ?? due[0]); setRevealed(false); }}>{say("Thẻ tiếp theo", "Next card")}</button>
      </>}
      {review.error && <Alert>{review.error.message}</Alert>}
    </> : <>
      {result && <p role="status" className="text-2xl font-semibold">{say("Kết quả", "Result")}: {result.score}/{result.total} ({Math.round(100 * result.score / result.total)}%)</p>}
      {(result?.items ?? set.items).map((item, i) => <fieldset key={i} className="space-y-3 rounded-xl border border-line p-5" disabled={!!result || submit.isPending}>
        <legend className="px-2 font-semibold">{i + 1}. {item.question}</legend>
        {item.options.map((option, j) => <label key={j} className="flex items-start gap-3 rounded-lg bg-soft p-3"><input className="mt-1" type="radio" name={`q-${set.id}-${i}`} checked={answers[i] === j} onChange={() => setAnswers(a => { const next = [...a]; next[i] = j; return next; })} />{option}</label>)}
        {result && <div className="space-y-2"><p className="font-semibold">{result.answers[i] === item.correct ? say("Đúng", "Correct") : say("Sai", "Incorrect")} · {say("Đáp án", "Answer")}: {item.options[item.correct ?? 0]}</p><p>{item.answer}</p><blockquote className="border-l-2 border-accent pl-4 text-sm text-muted">{item.source}</blockquote></div>}
      </fieldset>)}
      {!result ? <button className="btn-primary" disabled={submit.isPending || !set.items.every((_, i) => Number.isInteger(answers[i]))} onClick={() => submit.mutate()}>{submit.isPending ? say("Đang chấm…", "Grading…") : say("Nộp bài", "Submit")}</button> : <button className="btn-primary" onClick={() => { setResult(null); setAnswers([]); }}>{say("Làm lại", "Try again")}</button>}
      {submit.error && <Alert>{submit.error.message}</Alert>}
      <h3 className="font-semibold">{say("Lịch sử làm bài", "Attempt history")}</h3>
      {history.isPending && <Spinner />}{history.error && <Alert>{history.error.message}</Alert>}
      {history.data?.length === 0 && <p className="text-muted">{say("Chưa có lần làm bài nào.", "No attempts yet.")}</p>}
      {history.data?.map(a => <button key={a.id} className="btn-outline mr-2 mb-2" onClick={() => { setAnswers(a.answers); setResult(a); }}>{new Date(a.created_at).toLocaleString(lang)} · {a.score}/{a.total}</button>)}
    </>}
  </section>;
}
