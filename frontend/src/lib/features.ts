/** Parts of the app that are built but taken out of the interface, so the product stays on its three core jobs:
 * reading one's own documents, highlights and notebooks, and asking the AI about a document with citations.
 * Their pages, API and data are untouched: setting a flag back to `true` (and removing the matching redirect in
 * next.config) brings the part back. */

/** The feed of short cards at /feed. Its article page (/feed/read) and its chat live on under Explore. */
export const FEED = false;

/** Community posts and the publishing studio (/community, /publish), and the admin's post moderation. */
export const COMMUNITY = false;

/** The catalog of articles PureMind collected itself, managed from the admin's Articles and Crawl pages
 * (/admin/articles, /admin/crawl). Explore no longer reads it: the AI finds documents on the web, and the
 * catalog is empty. */
export const CATALOG = false;

/** AI notebooks: syntheses written from chosen highlights (/notebooks/new). The Notebook is now the reader's
 * own highlights and notes, one group per document, and what the AI writes gets there only through "Save to
 * notes". The syntheses already made stay readable under /notebooks/archive; making new ones is switched off. */
export const SYNTHESIS = false;

/* Reader v2 phase 4: the P1 extras of the reader (SRS 13, TSD 11.3 "flagged, validated and opt-in"). Each is
 * built, tested and switched on; setting one to `false` takes it out of the reader without touching its data. */

/** "Translate" in the selection menu: the passage in Vietnamese or English, kept as a note on request (AN-107). */
export const SELECTION_TRANSLATE = true;

/** "Explain" in the selection menu: the AI answers about the passage from where it is in the document (AI-110). */
export const SELECTION_EXPLAIN = true;

/** The mind map view of the AI tab (AI-109). */
export const MIND_MAP = true;

/** The research analysis of a study or a report, in the AI tab's summary view (AI-111). */
export const RESEARCH_ANALYSIS = true;
