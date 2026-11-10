/** The shared catalog as /explore shows it: what its topics mean, and where a reader might start. */

/** What an article found, written by the AI in Vietnamese to be read in under a minute. */
export type QuickRead = {
  title: string; problem: string; points: string[]; conclusion: string; results_complete: boolean;
};

export type Article = {
  id: string; title: string; topic: string; kind: string; language: string;
  source: string; authors: string; url: string; description: string; content?: string;
  word_count?: number; published_at?: string; license: string; license_url: string; attribution_url: string;
  content_note: string; quick?: QuickRead;
  /** Its Vietnamese title and line, for a card. */
  vi?: { title: string; description: string };
  /** Whether its text can be read in Vietnamese: the short reads. */
  translatable?: boolean;
  /** A handbook entry's place in the book: its chapter, the chapter's title and the entry's number ("4.1"). */
  chapter?: number; chapter_title?: string; ref?: string;
  /** How strong the evidence behind a handbook entry is, by the book's own scale. */
  grade?: Grade | "";
  /** Our own headline for an entry chosen to lead the page, in Vietnamese. */
  headline?: string;
};

export type Grade = "A" | "B" | "C";
export const GRADES: readonly Grade[] = ["A", "B", "C"];

/** A chapter of the handbook, with the topic it belongs to and how many of its entries the catalog has. */
export type Chapter = { number: number; title: string; topic: string; count: number };

export type Catalog = {
  total: number; topics: string[]; articles: Article[];
  /** What the whole catalog holds, whatever the filters: each topic's size, the chapters, each grade's size. */
  topic_counts?: Record<string, number>; chapters?: Chapter[]; grades?: Partial<Record<Grade, number>>;
};

export type ReadingLevel = "quick" | "full";

/** Where reading starts: the Quick Read, which is in Vietnamese, for a reader in Vietnamese; else the original. */
export function startingLevel(article: Article, lang: "vi" | "en"): ReadingLevel {
  return article.quick && lang === "vi" ? "quick" : "full";
}

/** The catalog names its topics in Vietnamese: the handbook's chapters in six groups. In the order the page lists
 * them, whichever the language. */
export const TOPICS = [
  {
    name: "Sức khỏe và an toàn", en: "Health and safety",
    about: { vi: "Sống lâu, ít bệnh, cấp cứu, thuốc men, mang thai và đi khám", en: "Living longer, staying well, first aid, medicines, pregnancy and seeing a doctor" },
  },
  {
    name: "Tâm lý và năng suất", en: "Mind and energy",
    about: { vi: "Giữ sức lực, dùng thời gian, nghỉ ngơi và đứng dậy sau cú sốc", en: "Saving your energy and time, resting, and getting through a hard blow" },
  },
  {
    name: "Tiền bạc và công việc", en: "Money and work",
    about: { vi: "Tiêu tiền khỏi oan, vay nợ, nhà ở, kinh doanh nhỏ và quyền lợi khi đi làm", en: "Spending wisely, debt, housing, small business and your rights at work" },
  },
  {
    name: "Pháp luật và quyền lợi", en: "Law and your rights",
    about: { vi: "Những ranh giới pháp luật dễ vấp, tài khoản, dữ liệu và luật giao thông", en: "Legal lines that are easy to cross, accounts, data and traffic rules" },
  },
  {
    name: "Gia đình và đời sống", en: "Family and life",
    about: { vi: "Yêu và cưới, nuôi con, chăm người già, ra nước ngoài và lúc người thân mất", en: "Love and marriage, raising children, caring for the old, going abroad and when someone dies" },
  },
  {
    name: "Học tập và phát triển", en: "Learning and growing",
    about: { vi: "Học gì thì đáng, cách học cho nhớ, các con đường sau 18 tuổi và du học", en: "What is worth learning, how to remember it, paths after 18 and studying abroad" },
  },
] as const;

/** The known topics in their set order, then any others the catalog has. */
export function orderTopics(names: string[]): string[] {
  const known: string[] = TOPICS.map((topic) => topic.name);
  return [
    ...known.filter((name) => names.includes(name)),
    ...names.filter((name) => !known.includes(name)).sort(),
  ];
}

/** A featured article, with its Vietnamese headline and dek when it was chosen by hand. */
export type Pick = { article: Article; title?: string; dek?: string };

/** The articles chosen by hand to lead, those with a headline of ours, in the catalog's order; if there are too
 * few, others fill in from topics not yet shown. A chosen one's dek is what the entry says in plain words. */
export function featuredOf(articles: Article[], count = 3): Pick[] {
  const picks: Pick[] = [];
  for (const article of articles) {
    if (article.headline && picks.length < count && !picks.some((p) => p.article.topic === article.topic)) {
      picks.push({ article, title: article.headline, dek: article.description });
    }
  }
  for (const article of readNext(articles, picks.map((p) => p.article), count)) {
    if (picks.length >= count) break;
    if (!picks.some((p) => p.article.topic === article.topic)) picks.push({ article });
  }
  return picks.slice(0, count);
}

/** Articles to go on with, taking one from each topic in turn so no topic crowds the rest out. */
export function readNext(articles: Article[], shown: Article[], count = 6): Article[] {
  const left = articles.filter((a) => !shown.some((s) => s.id === a.id));
  const topics = orderTopics([...new Set(left.map((a) => a.topic))]);
  const rows = topics.map((topic) => left.filter((a) => a.topic === topic));
  const next: Article[] = [];
  for (let depth = 0; next.length < count && rows.some((row) => row.length > depth); depth++) {
    for (const row of rows) {
      if (row[depth] && next.length < count) next.push(row[depth]);
    }
  }
  return next;
}
