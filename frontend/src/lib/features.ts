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
