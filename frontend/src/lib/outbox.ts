/**
 * Highlights on their way to the server (AN-105).
 *
 * A highlight the reader makes or edits is shown at once, marked as being saved, and stays so marked until
 * the server has answered. A request that fails for a passing reason (no network, a busy server) is sent
 * again a few times; sending twice is safe, because the id is chosen here and the server keeps one highlight
 * per id. When the tries are used up the highlight is marked as not saved and keeps what the reader did, so
 * nothing typed is thrown away and the reader can send it again.
 *
 * The server keeps one highlight per passage too: when the passage has one already it answers with that one,
 * and what was on its way goes on under that highlight's id.
 *
 * The requests themselves are passed in, so the order and the retries are tested without a network.
 */

import { ApiError } from "./api";
import type { Highlight } from "./annotations";

export type Fields = Partial<Pick<Highlight, "color" | "category">>;
export type Patch = Fields & { note?: string };

export interface Wire {
  /** Gives the highlight as the server holds it (the one saved earlier, when it is sent again). */
  create(h: Highlight): Promise<Highlight>;
  patch(id: string, fields: Fields): Promise<unknown>;
  /** One note per highlight; an empty one deletes it. */
  note(id: string, note: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}

export interface Unsaved {
  h: Highlight;
  /** Not on the server yet, as far as is known. */
  create: boolean;
}

interface Entry {
  /** The highlight as the reader sees it. */
  h: Highlight;
  create: boolean;
  /** Changes not yet sent (for a highlight that is already on the server). */
  fields: Fields;
  note?: string;
  /** Null while it is being sent; otherwise why it was not saved ("" when there is nothing more to say). */
  failed: string | null;
  told: ((saved: Highlight) => void)[];
  /** What the server said when it was made. */
  outcome?: Pick<Highlight, "duplicate" | "overlaps">;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
}

/** Waits before the second and the third try. */
export const RETRY_AFTER = [1000, 3000];
/** A note being typed is sent when the typing pauses. */
export const NOTE_DELAY = 700;

/** Worth another try: the request may not have arrived, or the server was busy. */
const passing = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status >= 500);

/** The highlight itself, without the marks of how its saving went. */
const plain = (h: Highlight): Highlight => {
  const out = { ...h };
  delete out.save;
  delete out.saveError;
  delete out.duplicate;
  delete out.overlaps;
  return out;
};

/** What only the server knows: when the highlight was made and where it stands in each view. */
const fromServer = (h: Highlight) => ({
  createdAt: h.createdAt,
  contentVersion: h.contentVersion,
  canonicalStart: h.canonicalStart,
  canonicalEnd: h.canonicalEnd,
  cleanAnchor: h.cleanAnchor,
  pdfAnchor: h.pdfAnchor,
  syncStatus: h.syncStatus,
});

/** The server's list with what is still on its way laid over it, so a reload of the list loses nothing. */
export function mergeUnsaved(server: Highlight[], unsaved: Unsaved[]): Highlight[] {
  if (!unsaved.length) return server;
  const mine = new Map(unsaved.map((u) => [u.h.id, u]));
  const out = server.map((h) => {
    const u = mine.get(h.id);
    if (!u) return h;
    mine.delete(h.id);
    return { ...u.h, ...fromServer(h) };
  });
  // An edit of a highlight the server no longer has is not shown: it was deleted somewhere else.
  for (const u of mine.values()) if (u.create) out.push(u.h);
  return out;
}

export function createOutbox(io: {
  wire: Wire;
  /** Show the highlight as it stands: `save` says it is on its way, or was not saved. */
  put(h: Highlight): void;
  /** All of it is on the server now. */
  saved(h: Highlight): void;
  /** The tries are used up, or the server refused. */
  failed(h: Highlight, error: unknown): void;
  /** The passage already had a highlight: `h` stands where the one with the id `from` was shown. */
  moved?(from: string, h: Highlight): void;
  wait?(ms: number): Promise<void>;
}) {
  const entries = new Map<string, Entry>();
  /** Requests for one highlight go one after another (create → edits → delete). */
  const chains = new Map<string, Promise<unknown>>();
  /** Ids given here to highlights the passage turned out to have already, and those highlights' ids. */
  const joined = new Map<string, string>();
  const real = (id: string) => joined.get(id) ?? id;
  const wait = io.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function attempt<T>(send: () => Promise<T>, wanted: () => boolean): Promise<T> {
    for (let n = 0; ; n++) {
      try {
        return await send();
      } catch (e) {
        if (!passing(e) || n >= RETRY_AFTER.length || !wanted()) throw e;
        await wait(RETRY_AFTER[n]);
      }
    }
  }

  const view = (e: Entry): Highlight =>
    e.failed === null ? { ...e.h, save: "saving" } : { ...e.h, save: "failed", ...(e.failed ? { saveError: e.failed } : {}) };

  function queue(id: string, run: () => Promise<unknown>): Promise<unknown> {
    const next = (chains.get(id) ?? Promise.resolve()).then(run);
    const kept = next.catch(() => undefined);
    chains.set(id, kept);
    void kept.then(() => {
      if (chains.get(id) === kept) chains.delete(id);
    });
    return next;
  }

  /**
   * The server already has this passage, as `row`. It stays as it is, with only what the reader changed while
   * the request was away on top. False when another entry was already looking after that highlight.
   */
  function join(entry: Entry, sent: Highlight, row: Highlight): boolean {
    const now = entry.h;
    entries.delete(sent.id);
    joined.set(sent.id, row.id);
    const fields: Fields = {};
    if (now.color !== sent.color) fields.color = now.color;
    if (now.category !== sent.category) fields.category = now.category;
    let note: string | undefined;
    if (now.note !== sent.note && !row.note.includes(now.note)) {
      note = row.note.trim() ? `${row.note}\n\n${now.note}` : now.note;
    }
    const changes = { ...fields, ...(note !== undefined ? { note } : {}) };
    const other = entries.get(row.id);
    if (other) {
      other.h = { ...other.h, ...changes };
      if (!other.create) {
        Object.assign(other.fields, fields);
        if (note !== undefined) other.note = note;
      }
      const { outcome } = entry;
      other.told.push(...entry.told.map((tell) => (saved: Highlight) => tell({ ...saved, ...outcome })));
      io.moved?.(sent.id, view(other));
      start(row.id);
      return false;
    }
    entry.h = { ...plain(row), ...changes };
    entry.fields = fields;
    entry.note = note;
    entries.set(row.id, entry);
    io.moved?.(sent.id, view(entry));
    return true;
  }

  /** Send what the entry still has to send, in order, until nothing is left or a request fails for good. */
  function start(given: string) {
    const entry = entries.get(real(given));
    if (!entry || entry.busy) return;
    entry.busy = true;
    const wanted = () => entries.get(entry.h.id) === entry;
    void queue(entry.h.id, async () => {
      try {
        while (wanted()) {
          if (entry.create) {
            const sent = entry.h;
            const row = await attempt(() => io.wire.create(sent), wanted);
            entry.create = false;
            entry.outcome = { duplicate: row.duplicate, overlaps: row.overlaps };
            if (!wanted()) return; // deleted meanwhile
            if (row.id !== sent.id) {
              if (join(entry, sent, row)) continue;
              return;
            }
            // What is left to send is whatever differs from the row the server holds: an edit made while
            // the request was away, or everything since an earlier try that did arrive.
            const now = entry.h;
            entry.h = { ...now, ...fromServer(row) };
            entry.fields = {};
            if (now.color !== row.color) entry.fields.color = now.color;
            if (now.category !== row.category) entry.fields.category = now.category;
            entry.note = now.note !== row.note ? now.note : undefined;
          } else if (Object.keys(entry.fields).length) {
            const fields = entry.fields;
            entry.fields = {};
            try {
              await attempt(() => io.wire.patch(entry.h.id, fields), wanted);
            } catch (e) {
              entry.fields = { ...fields, ...entry.fields };
              throw e;
            }
          } else if (entry.note !== undefined) {
            if (entry.timer) return; // still being typed: sent when the typing pauses
            const note = entry.note;
            entry.note = undefined;
            try {
              await attempt(() => io.wire.note(entry.h.id, note), wanted);
            } catch (e) {
              if (entry.note === undefined) entry.note = note;
              throw e;
            }
          } else {
            entries.delete(entry.h.id);
            io.saved(entry.h);
            for (const tell of entry.told) tell({ ...entry.h, ...entry.outcome });
            return;
          }
        }
      } catch (e) {
        if (!wanted()) return; // deleted meanwhile
        // A refusal about the content says why in its own words (too long, too many, no PDF to mark).
        entry.failed = e instanceof ApiError && e.status === 422 ? e.message : "";
        io.put(view(entry));
        io.failed(view(entry), e);
      } finally {
        entry.busy = false;
      }
    });
  }

  return {
    /** A new highlight: shown now, saved in the background. `onSaved` is called once the server has it. */
    add(h: Highlight, onSaved?: (saved: Highlight) => void) {
      const entry: Entry = { h: plain(h), create: true, fields: {}, failed: null, told: onSaved ? [onSaved] : [], busy: false };
      entries.set(h.id, entry);
      io.put(view(entry));
      start(h.id);
    },

    /**
     * A change to `current` (the highlight as it is shown). Colors are sent at once; a note being typed
     * waits for a pause unless `now` is set.
     */
    edit(
      current: Highlight,
      patch: Patch,
      { now = false, onSaved }: { now?: boolean; onSaved?: (saved: Highlight) => void } = {},
    ) {
      const id = real(current.id);
      let entry = entries.get(id);
      if (!entry) {
        entry = { h: { ...plain(current), id }, create: false, fields: {}, failed: null, told: [], busy: false };
        entries.set(id, entry);
      }
      entry.h = { ...entry.h, ...patch };
      const { note, ...fields } = patch;
      if (!entry.create) {
        // A highlight that is still to be created carries its changes with it.
        Object.assign(entry.fields, fields);
        if (note !== undefined) entry.note = note;
      }
      entry.failed = null;
      if (onSaved) entry.told.push(onSaved);
      io.put(view(entry));
      clearTimeout(entry.timer);
      entry.timer = undefined;
      if (note !== undefined && !now && !Object.keys(fields).length) {
        const typed = entry;
        typed.timer = setTimeout(() => {
          typed.timer = undefined;
          start(id);
        }, NOTE_DELAY);
      } else start(id);
    },

    /** Send again what was not saved. */
    retry(given: string) {
      const id = real(given);
      const entry = entries.get(id);
      if (!entry || entry.failed === null) return;
      entry.failed = null;
      io.put(view(entry));
      start(id);
    },

    /**
     * Delete the highlight. Whatever was on its way is dropped; the delete goes after any request already
     * sent, and a highlight the server never had counts as deleted.
     */
    remove(given: string): Promise<void> {
      const id = real(given);
      const entry = entries.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        entries.delete(id);
      }
      return queue(id, () =>
        attempt(() => io.wire.remove(id), () => !entries.has(id)).catch((e: unknown) => {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }),
      ).then(() => undefined);
    },

    /** Send the notes that were waiting for a pause (the page is being left). */
    flush() {
      for (const [id, entry] of entries) {
        if (!entry.timer) continue;
        clearTimeout(entry.timer);
        entry.timer = undefined;
        start(id);
      }
    },

    unsaved: (): Unsaved[] => [...entries.values()].map((e) => ({ h: view(e), create: e.create })),

    /** The id a highlight goes by now. */
    resolve: real,

    /** Forget everything (another person signed in). */
    clear() {
      for (const entry of entries.values()) clearTimeout(entry.timer);
      entries.clear();
      joined.clear();
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
