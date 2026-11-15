import { afterEach, describe, expect, it, vi } from "vitest";

import type { Highlight } from "./annotations";
import { ApiError } from "./api";
import { NOTE_DELAY, RETRY_AFTER, createOutbox, mergeUnsaved, type Wire } from "./outbox";

const hl = (over: Partial<Highlight> = {}): Highlight => ({
  id: "h1",
  docId: "d1",
  blockId: "b1",
  start: 0,
  end: 5,
  rects: null,
  text: "words",
  color: "yellow",
  category: "important",
  note: "",
  page: 1,
  createdAt: "2026-11-14T00:00:00.000Z",
  ...over,
});

const offline = () => new ApiError(0, "offline");
/** Let every promise that is ready run. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

function setup(over: Partial<Wire> = {}) {
  const wire = {
    create: vi.fn(async (h: Highlight) => ({ ...h, contentVersion: "v1" })),
    patch: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    ...over,
  } satisfies Wire;
  const shown: Highlight[] = [];
  const saved: Highlight[] = [];
  const failed: Highlight[] = [];
  const waits: number[] = [];
  const box = createOutbox({
    wire,
    put: (h) => shown.push(h),
    saved: (h) => saved.push(h),
    failed: (h) => failed.push(h),
    wait: async (ms) => void waits.push(ms),
  });
  return { box, wire, shown, saved, failed, waits };
}

afterEach(() => vi.useRealTimers());

describe("saving a highlight", () => {
  it("shows it as being saved, and says saved only after the server has answered", async () => {
    let answer!: (h: Highlight) => void;
    const { box, shown, saved } = setup({ create: (h) => new Promise((resolve) => (answer = () => resolve(h))) });
    const told = vi.fn();
    box.add(hl(), told);
    await settle();
    expect(shown.at(-1)?.save).toBe("saving");
    expect(told).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(box.unsaved()).toEqual([{ h: { ...hl(), save: "saving" }, create: true }]);

    answer(hl());
    await settle();
    expect(told).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].save).toBeUndefined();
    expect(box.unsaved()).toEqual([]);
  });

  it("keeps what the server says about the text it was made on", async () => {
    const { box, saved } = setup();
    box.add(hl());
    await settle();
    expect(saved[0].contentVersion).toBe("v1");
  });

  it("sends again, with the same id, when the network drops", async () => {
    let n = 0;
    const create = vi.fn(async (h: Highlight) => {
      if (n++ < 2) throw offline();
      return h;
    });
    const { box, saved, failed, waits } = setup({ create });
    box.add(hl());
    await settle();
    expect(create).toHaveBeenCalledTimes(3);
    expect(new Set(create.mock.calls.map(([h]) => h.id))).toEqual(new Set(["h1"]));
    expect(waits).toEqual(RETRY_AFTER);
    expect(saved).toHaveLength(1);
    expect(failed).toHaveLength(0);
  });

  it("stops after a few tries, keeps the highlight as not saved, and saves it on a retry", async () => {
    let down = true;
    const create = vi.fn(async (h: Highlight) => {
      if (down) throw offline();
      return h;
    });
    const { box, shown, saved, failed } = setup({ create });
    const told = vi.fn();
    box.add(hl(), told);
    await settle();
    expect(create).toHaveBeenCalledTimes(1 + RETRY_AFTER.length);
    expect(failed).toHaveLength(1);
    expect(shown.at(-1)?.save).toBe("failed");
    expect(told).not.toHaveBeenCalled();
    expect(box.unsaved()).toMatchObject([{ create: true, h: { id: "h1", save: "failed" } }]);

    down = false;
    box.retry("h1");
    expect(shown.at(-1)?.save).toBe("saving");
    await settle();
    expect(saved).toHaveLength(1);
    expect(told).toHaveBeenCalledTimes(1);
    expect(box.unsaved()).toEqual([]);
  });

  it("does not repeat a request the server refused, and keeps its reason", async () => {
    const create = vi.fn(async () => {
      throw new ApiError(422, "Too many highlights.");
    });
    const { box, shown, waits } = setup({ create });
    box.add(hl());
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(shown.at(-1)).toMatchObject({ save: "failed", saveError: "Too many highlights." });
  });

  it("sends a color picked while the highlight was on its way", async () => {
    let answer!: () => void;
    const first = hl();
    const { box, wire, saved } = setup({ create: (h) => new Promise((resolve) => (answer = () => resolve(h))) });
    box.add(first);
    await settle();
    box.edit({ ...first, save: "saving" }, { color: "blue", category: "concept" });
    answer(); // the server holds the yellow one
    await settle();
    expect(wire.patch).toHaveBeenCalledWith("h1", { color: "blue", category: "concept" });
    expect(saved.at(-1)).toMatchObject({ color: "blue", category: "concept" });
    expect(saved.at(-1)?.save).toBeUndefined();
  });

  it("sends what is missing when an earlier try had already arrived", async () => {
    // The first request reached the server but its answer was lost; meanwhile a note was written.
    const create = vi.fn(async (h: Highlight) => ({ ...h, note: "" }));
    const { box, wire } = setup({ create });
    box.add(hl({ note: "my thought" }));
    await settle();
    expect(wire.note).toHaveBeenCalledWith("h1", "my thought");
  });
});

describe("editing a saved highlight", () => {
  it("waits for a pause in the typing, then sends the note once", async () => {
    vi.useFakeTimers();
    const { box, wire, shown, saved } = setup();
    const h = hl();
    box.edit(h, { note: "a" });
    box.edit(h, { note: "ab" });
    await vi.advanceTimersByTimeAsync(NOTE_DELAY - 1);
    expect(wire.note).not.toHaveBeenCalled();
    expect(shown.at(-1)).toMatchObject({ note: "ab", save: "saving" });
    await vi.advanceTimersByTimeAsync(1);
    expect(wire.note).toHaveBeenCalledTimes(1);
    expect(wire.note).toHaveBeenCalledWith("h1", "ab");
    expect(saved.at(-1)).toMatchObject({ note: "ab" });
  });

  it("sends at once when asked to, and tells when it is saved", async () => {
    const { box, wire } = setup();
    const told = vi.fn();
    box.edit(hl(), { note: "done" }, { now: true, onSaved: told });
    expect(told).not.toHaveBeenCalled();
    await settle();
    expect(wire.note).toHaveBeenCalledWith("h1", "done");
    expect(told).toHaveBeenCalledTimes(1);
  });

  it("sends a waiting note when the page is left", async () => {
    vi.useFakeTimers();
    const { box, wire } = setup();
    box.edit(hl(), { note: "half a thou" });
    box.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(wire.note).toHaveBeenCalledWith("h1", "half a thou");
  });

  it("keeps the note that could not be saved, through a reload of the list", async () => {
    const note = vi.fn(async () => {
      throw new ApiError(503, "busy");
    });
    const { box, shown, failed } = setup({ note });
    const told = vi.fn();
    box.edit(hl(), { note: "a long thought" }, { now: true, onSaved: told });
    await settle();
    expect(note).toHaveBeenCalledTimes(1 + RETRY_AFTER.length);
    expect(failed).toHaveLength(1);
    expect(told).not.toHaveBeenCalled();
    expect(shown.at(-1)).toMatchObject({ note: "a long thought", save: "failed" });
    // The server still has the highlight without the note; the list keeps what the reader wrote.
    expect(mergeUnsaved([hl()], box.unsaved())).toMatchObject([{ note: "a long thought", save: "failed" }]);
  });

  it("sends the latest color when two are picked quickly", async () => {
    const { box, wire, saved } = setup();
    const h = hl();
    box.edit(h, { color: "green", category: "example" });
    box.edit(h, { color: "pink", category: "question" });
    await settle();
    expect(vi.mocked(wire.patch).mock.calls.at(-1)).toEqual(["h1", { color: "pink", category: "question" }]);
    expect(saved.at(-1)).toMatchObject({ color: "pink" });
  });
});

describe("deleting a highlight", () => {
  it("waits for the request already sent, then deletes", async () => {
    const order: string[] = [];
    let answer!: () => void;
    const { box, saved } = setup({
      create: (h) =>
        new Promise((resolve) => {
          order.push("create sent");
          answer = () => {
            order.push("create answered");
            resolve(h);
          };
        }),
      remove: async () => void order.push("delete sent"),
    });
    box.add(hl());
    await settle();
    const gone = box.remove("h1");
    await settle();
    expect(order).toEqual(["create sent"]);
    answer();
    await gone;
    expect(order).toEqual(["create sent", "create answered", "delete sent"]);
    expect(saved).toHaveLength(0); // never said saved: it was deleted
    expect(box.unsaved()).toEqual([]);
  });

  it("counts a highlight the server never had as deleted", async () => {
    const { box } = setup({
      remove: async () => {
        throw new ApiError(404, "not found");
      },
    });
    await expect(box.remove("h1")).resolves.toBeUndefined();
  });

  it("says so when the delete could not be sent", async () => {
    const remove = vi.fn(async () => {
      throw offline();
    });
    const { box } = setup({ remove });
    await expect(box.remove("h1")).rejects.toBeInstanceOf(ApiError);
    expect(remove).toHaveBeenCalledTimes(1 + RETRY_AFTER.length);
  });
});

describe("mergeUnsaved", () => {
  const onServer = hl({ id: "s1", contentVersion: "v1" });

  it("is the server's list when nothing is on its way", () => {
    const list = [onServer];
    expect(mergeUnsaved(list, [])).toBe(list);
  });

  it("adds a highlight that is not on the server yet", () => {
    const mine = hl({ id: "n1", save: "saving" });
    expect(mergeUnsaved([onServer], [{ h: mine, create: true }])).toEqual([onServer, mine]);
  });

  it("does not show a highlight twice once the server has it", () => {
    const mine = hl({ id: "s1", save: "saving", color: "blue" });
    expect(mergeUnsaved([onServer], [{ h: mine, create: true }])).toEqual([{ ...mine, contentVersion: "v1" }]);
  });

  it("drops an edit of a highlight that was deleted somewhere else", () => {
    const edit = hl({ id: "gone", note: "x", save: "saving" });
    expect(mergeUnsaved([onServer], [{ h: edit, create: false }])).toEqual([onServer]);
  });
});

it("forgets everything when asked", async () => {
  const { box } = setup({
    create: async () => {
      throw new ApiError(422, "no");
    },
  });
  box.add(hl());
  await settle();
  expect(box.unsaved()).toHaveLength(1);
  box.clear();
  expect(box.unsaved()).toEqual([]);
});
