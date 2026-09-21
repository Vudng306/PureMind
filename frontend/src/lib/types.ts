export type Theme = "light" | "dark" | "sepia";

export interface ReadingPreferences {
  theme?: Theme;
  font_size?: number;
  line_height?: 1.5 | 1.65 | 1.8;
  column_width?: 600 | 680 | 780;
  default_mode?: "clean" | "original";
  color_labels?: { yellow: string; green: string; blue: string; pink: string; purple?: string };
  ai_consent?: boolean;
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
  created_at: string;
  updated_at: string;
}

export type ExtractionStatus = "pending" | "processing" | "done" | "failed";

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
  created_at: string;
  updated_at: string;
}

export interface DocumentDetail extends DocumentListItem {
  content_clean: string;
  note: string;
}
