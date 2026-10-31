"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

type Article = {
  id: string; title: string; topic: string; kind: string; language: string;
  source: string; authors: string; url: string; description: string; content?: string;
  published_at?: string; license: string; license_url: string; attribution_url: string;
  content_note: string;
};
type Catalog = { total: number; topics: string[]; articles: Article[] };

/** The shared library of open articles (Europe PMC, CC BY), read in place: the "open articles" tab of /explore. */
export function SharedLibrary() {
  const [data, setData] = useState<Catalog | null>(null);
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState("");
  const [offset, setOffset] = useState(0);
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q, topic, kind, offset: String(offset) });
      fetch(`${API_URL}/api/catalog?${params}`, { signal: controller.signal })
        .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
        .then((value: Catalog) => { setData(value); setError(""); })
        .catch((e) => { if (e.name !== "AbortError") setError("Không tải được kho bài. Hãy thử tải lại trang."); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [q, topic, kind, offset]);

  async function open(item: Article) {
    setArticle(item);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/catalog/${item.id}`);
      if (!response.ok) throw new Error();
      const full: Article = await response.json();
      setArticle((current) => current?.id === full.id ? full : current);
    } catch { setError("Không tải được nội dung bài. Vui lòng thử lại."); }
  }

  return (
    <div>
      {article ? (
        <article className="mx-auto max-w-3xl">
          <button onClick={() => setArticle(null)} className="mb-6 underline">← Kho bài chung</button>
          <p className="mb-3 text-sm text-muted">{article.topic} · {article.source} · {article.language.toUpperCase()}</p>
          <h1 className="mb-4 font-serif text-3xl leading-tight">{article.title}</h1>
          <p className="mb-3 text-sm">{article.authors}{article.published_at ? ` · ${article.published_at}` : ""}</p>
          <p className="mb-5 text-sm">
            <a href={article.url} target="_blank" rel="noreferrer" className="underline">Bản gốc</a>
            {" · "}<a href={article.license_url} target="_blank" rel="noreferrer" className="underline">{article.license}</a>
            {" · "}<a href={article.attribution_url} target="_blank" rel="noreferrer" className="underline">Nguồn và tác giả</a>
          </p>
          <p className="mb-8 rounded-xl bg-soft p-4 text-sm">{article.content_note}</p>
          {error && <p role="alert" className="mb-4 text-red-600">{error}</p>}
          <div className="whitespace-pre-wrap break-words font-serif text-lg leading-loose">{article.content ?? (error ? "" : "Đang tải nội dung…")}</div>
        </article>
      ) : (
        <>
          <p className="text-muted">Bài viết và nghiên cứu từ nguồn mở, có sẵn cho mọi người.</p>
          <div className="my-7 flex flex-wrap gap-3">
            <input aria-label="Tìm bài viết" placeholder="Tìm chủ đề, tiêu đề, tác giả…" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} className="min-w-56 flex-1 rounded-xl border border-line bg-bg p-3" />
            <select aria-label="Chủ đề" value={topic} onChange={(e) => { setTopic(e.target.value); setOffset(0); }} className="rounded-xl border border-line bg-bg p-3">
              <option value="">Mọi chủ đề</option>{data?.topics.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select aria-label="Loại bài" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }} className="rounded-xl border border-line bg-bg p-3">
              <option value="">Mọi loại bài</option><option value="research">Bài khoa học</option>
            </select>
          </div>
          {error && <p role="alert" className="mb-5 text-red-600">{error}</p>}
          <p role="status" className="mb-5 text-sm text-muted">{loading ? "Đang tải…" : `${data?.total ?? 0} bài viết`}</p>
          {!loading && data?.total === 0 && <p>Chưa có bài phù hợp. Hãy thử từ khóa hoặc chủ đề khác.</p>}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {data?.articles.map((a) => (
              <button key={a.id} onClick={() => void open(a)} className="flex flex-col rounded-2xl border border-line p-6 text-left transition hover:bg-soft">
                <span className="mb-3 text-xs text-muted">{a.topic} · {a.language.toUpperCase()}</span>
                <h2 className="mb-3 font-serif text-xl leading-snug">{a.title}</h2>
                <p className="mb-5 line-clamp-4 text-sm leading-relaxed text-muted">{a.description}</p>
                <span className="mt-auto text-xs">{a.source} · {a.license}</span>
              </button>
            ))}
          </div>
          {data && data.total > 24 && <div className="mt-6 flex items-center justify-center gap-5">
            <button disabled={offset === 0} onClick={() => setOffset(offset - 24)} className="disabled:opacity-30">← Trước</button>
            <span>{Math.floor(offset / 24) + 1} / {Math.ceil(data.total / 24)}</span>
            <button disabled={offset + 24 >= data.total} onClick={() => setOffset(offset + 24)} className="disabled:opacity-30">Sau →</button>
          </div>}
        </>
      )}
    </div>
  );
}
