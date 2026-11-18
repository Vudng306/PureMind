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
