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
};
export type Catalog = { total: number; topics: string[]; articles: Article[] };

export type ReadingLevel = "quick" | "full";

/** Where reading starts: the Quick Read, which is in Vietnamese, for a reader in Vietnamese; else the original. */
export function startingLevel(article: Article, lang: "vi" | "en"): ReadingLevel {
  return article.quick && lang === "vi" ? "quick" : "full";
}

/** The catalog names its topics in Vietnamese. In the order the page lists them, whichever the language. */
export const TOPICS = [
  {
    name: "Tâm lý và các mối quan hệ", en: "Mind and relationships",
    about: { vi: "Cô đơn, tình bạn, tình yêu và cách ta gắn kết với nhau", en: "Loneliness, friendship, love and how we connect" },
  },
  {
    name: "Mạng xã hội và công nghệ", en: "Social media and technology",
    about: { vi: "Điều màn hình và mạng xã hội làm với đời sống của ta", en: "What screens and social media do to our lives" },
  },
  {
    name: "Gia đình và nuôi dạy con", en: "Family and parenting",
    about: { vi: "Làm cha mẹ, tình thân và cách trẻ lớn lên", en: "Being a parent, family bonds and growing up" },
  },
  {
    name: "Công việc và kinh tế", en: "Work and the economy",
    about: { vi: "Động lực, áp lực và những cách làm việc mới", en: "Motivation, pressure and new ways of working" },
  },
  {
    name: "Di cư và hòa nhập", en: "Migration and belonging",
    about: { vi: "Rời quê hương và tìm chỗ đứng ở một nơi mới", en: "Leaving home and finding a place somewhere new" },
  },
  {
    name: "Đô thị và cộng đồng", en: "Cities and communities",
    about: { vi: "Khu phố, công viên và ai được sống tốt trong thành phố", en: "Neighbourhoods, parks and who gets to live well in a city" },
  },
  {
    name: "Giáo dục", en: "Education",
    about: { vi: "Lớp học, người thầy và việc học trong thời AI", en: "Classrooms, teachers and learning in the age of AI" },
  },
  {
    name: "Sức khỏe cộng đồng", en: "Public health",
    about: { vi: "Công bằng sức khỏe và cách một xã hội chăm lo cho nhau", en: "Health equity and how a society looks after itself" },
  },
  {
    name: "Môi trường", en: "Environment",
    about: { vi: "Rác nhựa, rừng, đa dạng sinh học và khí hậu đang đổi thay", en: "Plastic, forests, biodiversity and a changing climate" },
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

/** Where to start reading: short reads chosen by hand, named by the end of their address, which outlives a new
 * choosing. The Vietnamese headline and dek are ours, saying what the article is about in our own words: most of
 * these may be shown only as written, so neither translates its text. */
const FEATURED = [
  {
    ending: "around-half-of-people-will-experience-a-mental-health-issue-in-their-lifetime",
    title: "Cứ hai người thì có một người sẽ gặp vấn đề sức khỏe tâm thần trong đời",
    dek: "Khảo sát hơn 150.000 người ở 29 quốc gia: khoảng một nửa sẽ mắc ít nhất một trong các rối loạn được nghiên cứu trước tuổi 75, và con số thật có thể còn cao hơn.",
  },
  {
    ending: "the-ick-the-psychology-of-why-a-romantic-partner-can-suddenly-repulse-you-293266",
    title: "“The ick”: vì sao đang thích một người, bỗng dưng thấy phát ngán?",
    dek: "Một nhà tâm lý học điểm qua các cách giải thích, từ tiến hóa đến kiểu gắn bó, và cho rằng câu trả lời tùy từng người.",
  },
  {
    ending: "what-an-exhibition-by-artists-of-the-vietnamese-diaspora-says-about-home-and-belonging-204471",
    title: "Ghế nhựa và bát cơm: với người Việt xa xứ, “nhà” là gì?",
    dek: "Từ triển lãm của tám nghệ sĩ gốc Việt ở London, một nhà ngôn ngữ học kể về những góc Việt Nam ẩn mình ở Anh, Đức, Pháp, Canada và Mỹ.",
  },
];

/** A featured article, with its Vietnamese headline and dek when it was chosen by hand. */
export type Pick = { article: Article; title?: string; dek?: string };

/** The hand-chosen articles still in the catalog; if a new choosing dropped some, others fill in from topics not
 * yet shown. */
export function featuredOf(articles: Article[], count = 3): Pick[] {
  const picks: Pick[] = [];
  for (const { ending, title, dek } of FEATURED) {
    const article = articles.find((a) => a.url.endsWith(`/${ending}`));
    if (article) picks.push({ article, title, dek });
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
