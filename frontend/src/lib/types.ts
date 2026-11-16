/** The backgrounds the reader offers for one sitting (FR-RDR-03). */
export type Theme = "light" | "dark" | "sepia";

/** The app itself only has day and night: the sepia page is a reading background, not a skin. */
export type AppTheme = "light" | "dark";

/** The language of the interface (FR-ACC-04), kept with the account so it follows the reader. */
export type Lang = "vi" | "en";

export interface ReadingPreferences {
  theme?: Theme;
  font_size?: number;
  line_height?: 1.5 | 1.65 | 1.8;
  column_width?: 600 | 680 | 780;
  default_mode?: "clean" | "original";
  color_labels?: { yellow: string; green: string; blue: string; pink: string; purple?: string };
  ai_consent?: boolean;
  language?: Lang;
  /** The face the clean text is set in (RD-104). */
  font_family?: "serif" | "sans";
  /** The page the reader reads on (RD-105); null follows the theme of the app. */
  reading_theme?: Theme | null;
  /** Show the estimate of the reading time left (RD-112). */
  time_left?: boolean;
}

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  reading_preferences: ReadingPreferences;
  /** AI requests left today (resets at 00:00 Vietnam time). */
  ai_quota_remaining: number;
  /** Chat questions left today, counted apart from summaries and notebooks (FR-CHAT-02). */
  chat_quota_remaining: number;
  /** FR-ADM-01: "admin" opens the admin pages; the server checks it again on every request. */
  role: "user" | "admin";
  /** False until the current terms of use are accepted (sign-up form or the welcome screen). */
  terms_accepted: boolean;
  created_at: string;
  updated_at: string;
}

export type ExtractionStatus = "pending" | "processing" | "done" | "failed";

export type CitationType = "article" | "book" | "chapter" | "conference" | "thesis" | "report" | "misc";

/** `family` alone is a name kept whole, e.g. an organisation. */
export interface CitationAuthor {
  family: string;
  given: string;
}

/** How a document is cited: filled from its DOI or by hand, written out as BibTeX. */
export interface Citation {
  type: CitationType;
  authors: CitationAuthor[];
  /** The journal, the book or the proceedings the work appeared in. */
  container: string;
  publisher: string;
  year: number | null;
  volume: string;
  issue: string;
  pages: string;
  doi: string;
}

export interface DocumentListItem {
  id: string;
  title: string;
  source_type: "upload" | "manual";
  file_type: "pdf" | "epub" | "web";
  url: string | null;
  original_filename: string | null;
  file_size: number | null;
  page_count: number | null;
  word_count: number | null;
  reading_minutes: number | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  last_read_page: number | null;
  /** Clean-text scroll position 0..1 */
  read_fraction: number | null;
  is_read: boolean;
  citation: Citation | null;
  /** The shelf it is on, if any. */
  collection_id: string | null;
  /** The licence the source states; null for a private upload or a page we know nothing about. */
  license: string | null;
  /** Topics of the Explore article it came from. */
  topics: string[];
  created_at: string;
  updated_at: string;
}

/** The place in the clean text: the block at the top of the page and how far into it (0..1). */
export interface ReadPosition {
  block_id: string;
  offset: number;
}

/** Something the extraction knows is not in the clean text as text (RD-111). */
export interface ExtractionIssue {
  code: "scanned_pages" | "ocr_pages" | "tables_as_images" | "equations_as_images";
  count: number;
  pages?: number[] | null;
}

export interface DocumentDetail extends DocumentListItem {
  content_clean: string;
  /** Names the clean text as it is now; a highlight made on another one carries another name (AN-102). */
  content_version?: string | null;
  note: string;
  read_position: ReadPosition | null;
  /** Empty when the extraction found nothing left out; null when it was never recorded. */
  extraction_issues: ExtractionIssue[] | null;
  /** Clean Reader UC-04: the file read again. Null when it never was. */
  reprocess_state?: "running" | "done" | "failed" | null;
  reprocess_report?: ReprocessReport | null;
}

/** How the last reading-again went: the highlights checked against the new text, or why it failed. */
export interface ReprocessReport {
  finished_at?: string;
  error?: string;
  from_version?: string | null;
  to_version?: string | null;
  anchors?: { mapped: number; ambiguous: number; unresolved: number };
  /** The place the reader was at, in a block the new text no longer has. */
  read_position?: ReadPosition;
}
