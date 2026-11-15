import { describe, expect, it } from "vitest";

import { CONTEXT, contextOf, locate, type Anchored, type TextBlock } from "./anchor";

const block = (id: string, text: string, page = 1): TextBlock => ({ id, text, page });

/** A highlight of `quote` made in `b`, the way the reader makes one. */
function made(b: TextBlock, quote: string, nth = 0): Anchored {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = b.text.indexOf(quote, start + 1);
  const end = start + quote.length;
  return { blockId: b.id, start, end, text: quote, page: b.page, ...contextOf(b.text, start, end) };
}

describe("contextOf", () => {
  it("keeps the words on each side, no more than the limit", () => {
    const text = `${"a".repeat(50)} the passage ${"b".repeat(50)}`;
    const start = text.indexOf("the passage");
    const { prefix, suffix } = contextOf(text, start, start + 11);
    expect(prefix).toHaveLength(CONTEXT);
    expect(suffix).toHaveLength(CONTEXT);
    expect(prefix.endsWith("a ")).toBe(true);
    expect(suffix.startsWith(" b")).toBe(true);
  });

  it("is empty at the edges of a block", () => {
    expect(contextOf("whole", 0, 5)).toEqual({ prefix: "", suffix: "" });
  });

  it("never cuts a two-unit character in half", () => {
    const halved = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    // One letter between the faces and the word puts both cuts in the middle of a face.
    const text = `${"😀".repeat(20)}aworda${"😀".repeat(20)}`;
    const { prefix, suffix } = contextOf(text, 41, 45);
    expect(prefix).toHaveLength(CONTEXT - 1);
    expect(suffix).toHaveLength(CONTEXT - 1);
    expect(halved.test(prefix)).toBe(false);
    expect(halved.test(suffix)).toBe(false);
  });
});

describe("locate", () => {
  const intro = block("b1", "Reading is a habit that grows with small steps taken every single day.");
  const body = block("b2", "A habit needs a cue, a routine and a reward before it can last for years.", 2);

  it("keeps the stored position while the words there are the same (AT-08)", () => {
    const h = made(intro, "small steps");
    expect(locate([intro, body], h)).toEqual({ state: "exact", spot: { blockId: "b1", start: h.start, end: h.end } });
  });

  it("follows a long passage to the one place it is now (re-extract changed the block)", () => {
    const h = made(body, "a cue, a routine and a reward");
    const again = block("b9", `Every expert agrees: a habit needs a cue, a routine and a reward to last.`, 2);
    const placed = locate([intro, again], h);
    expect(placed.state).toBe("moved");
    expect(placed.spot && again.text.slice(placed.spot.start, placed.spot.end)).toBe(h.text);
  });

  it("finds the passage again when only spacing, case or accents changed", () => {
    const viet = block("v1", "Thói quen đọc sách mỗi ngày giúp trí nhớ tốt hơn rất nhiều.");
    const h = made(viet, "đọc sách mỗi ngày giúp trí nhớ");
    const again = block("v2", "Thói quen Đọc  sách mỗi\nngày giúp trí nhớ tốt hơn.");
    const placed = locate([again], h);
    expect(placed.state).toBe("moved");
    expect(placed.spot && again.text.slice(placed.spot.start, placed.spot.end)).toBe("Đọc  sách mỗi\nngày giúp trí nhớ");
  });

  it("says lost when the passage is no longer in the text, and places nothing (AT-11)", () => {
    const h = made(body, "a cue, a routine and a reward");
    expect(locate([intro, block("b9", "This paragraph was rewritten from scratch.")], h)).toEqual({
      state: "lost",
      spot: null,
    });
  });

  it("uses the words around a passage to tell two copies apart", () => {
    const one = block("c1", "First we say the key idea and then move on to the next thing.");
    const two = block("c2", "Later we repeat the key idea but in a different light entirely.");
    const h = made(two, "the key idea");
    // Both blocks were re-read, so neither id is known any more.
    const a = block("d1", `${one.text} More.`);
    const b = block("d2", `${two.text} More.`);
    const placed = locate([a, b], h);
    expect(placed).toMatchObject({ state: "moved", spot: { blockId: "d2" } });
  });

  it("asks for a look when several places fit and nothing settles which (AT-11, AT-24)", () => {
    const h: Anchored = { blockId: "gone", start: 4, end: 16, text: "the key idea", page: null };
    const a = block("d1", "Say the key idea once.");
    const b = block("d2", "Say the key idea twice.");
    expect(locate([a, b], h)).toEqual({ state: "review", spot: null });
  });

  it("asks for a look when the words around both copies read the same", () => {
    const one = block("c1", "We say the key idea here.");
    const h = made(one, "the key idea");
    const a = block("d1", "We say the key idea here. And more.");
    const b = block("d2", "We say the key idea here. And less.");
    expect(locate([a, b], h).state).toBe("review");
  });

  it("does not move a few words to another paragraph that happens to hold them", () => {
    const own = block("c1", "The result was important for the whole field of study.");
    const h = made(own, "important");
    // Its own paragraph is gone; the word survives once, somewhere unrelated.
    const other = block("d7", "Nothing here is important, said the second author.", 4);
    expect(locate([other], h)).toEqual({ state: "review", spot: null });
  });

  it("moves a few words when the text around them still agrees", () => {
    const own = block("c1", "The result was important for the whole field of study.");
    const h = made(own, "important");
    const again = block("d1", "The result was important for the whole field of study, they wrote.");
    expect(locate([again], h)).toMatchObject({ state: "moved", spot: { blockId: "d1", start: 15, end: 24 } });
  });

  it("places a highlight made on a PDF page by its page", () => {
    const h: Anchored = { blockId: null, start: null, end: null, text: "a habit", page: 2 };
    // Written this way the words are only on page 1, which is not where the highlight was made.
    expect(locate([intro, body], h)).toEqual({ state: "review", spot: null });
    // Written as on page 2, they are found once, on that page.
    const capital: Anchored = { ...h, text: "A habit" };
    expect(locate([intro, body], capital)).toEqual({ state: "moved", spot: { blockId: "b2", start: 0, end: 7 } });
  });

  it("leaves a PDF highlight unplaced when its page holds the words twice", () => {
    const h: Anchored = { blockId: null, start: null, end: null, text: "habit", page: 2 };
    const twice = block("b3", "One habit leads to another habit.", 2);
    expect(locate([intro, twice], h).state).toBe("review");
  });

  it("does not trust a single short match on another page for a PDF highlight", () => {
    const h: Anchored = { blockId: null, start: null, end: null, text: "reward", page: 5 };
    expect(locate([intro, body], h).state).toBe("review");
    expect(locate([intro, body], { ...h, page: 2 }).state).toBe("moved");
  });

  it("an older highlight without context still follows a long passage found once", () => {
    const h: Anchored = { blockId: "old", start: 0, end: 29, text: "a cue, a routine and a reward", page: 2 };
    expect(locate([intro, body], h).state).toBe("moved");
  });

  it("places nothing for an empty quote", () => {
    expect(locate([intro], { blockId: null, start: null, end: null, text: "", page: null }).state).toBe("lost");
  });
});
