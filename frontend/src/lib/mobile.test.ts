import { describe, expect, it } from "vitest";

import { followScroll, keyboardInset, scrollAfterZoom, settleSheet } from "./mobile";

const STOPS = ["half", "full"] as const;

describe("followScroll", () => {
  const shown = { shown: true, anchor: 500 };
  const hidden = { shown: false, anchor: 500 };

  it("hides the bars when reading on, and brings them back on the way up", () => {
    expect(followScroll(shown, 540, 5000).shown).toBe(false);
    expect(followScroll(hidden, 460, 5000).shown).toBe(true);
  });

  it("ignores a small movement", () => {
    expect(followScroll(shown, 510, 5000).shown).toBe(true);
    expect(followScroll(hidden, 490, 5000).shown).toBe(false);
  });

  it("adds up a slow scroll", () => {
    let bars = shown;
    for (let top = 505; top <= 530; top += 5) bars = followScroll(bars, top, 5000);
    expect(bars.shown).toBe(false);
  });

  it("measures a turn from the furthest point reached", () => {
    const down = followScroll(hidden, 900, 5000);
    expect(down).toEqual({ shown: false, anchor: 900 });
    expect(followScroll(down, 870, 5000).shown).toBe(true);
  });

  it("always shows them at either end of the text", () => {
    expect(followScroll(hidden, 4, 5000).shown).toBe(true);
    expect(followScroll(hidden, 4990, 5000).shown).toBe(true);
  });
});

describe("settleSheet", () => {
  it("stays put after a small, slow drag", () => {
    expect(settleSheet(STOPS, "half", 20, 400)).toBe("half");
    expect(settleSheet(STOPS, "full", -20, 400)).toBe("full");
  });

  it("moves one stop per gesture", () => {
    expect(settleSheet(STOPS, "half", -200, 400)).toBe("full");
    expect(settleSheet(STOPS, "full", 500, 400)).toBe("half");
  });

  it("closes when dragged down from the lowest stop", () => {
    expect(settleSheet(STOPS, "half", 100, 400)).toBe("closed");
    expect(settleSheet(["content"] as const, "content", 100, 400)).toBe("closed");
  });

  it("counts a short flick as a full drag", () => {
    expect(settleSheet(STOPS, "half", 40, 50)).toBe("closed");
    expect(settleSheet(STOPS, "half", -40, 50)).toBe("full");
  });

  it("does not go above the highest stop", () => {
    expect(settleSheet(STOPS, "full", -300, 200)).toBe("full");
  });
});

describe("keyboardInset", () => {
  it("measures the keyboard", () => {
    expect(keyboardInset(800, 460, 0)).toBe(340);
  });

  it("takes a scrolled visual viewport into account", () => {
    expect(keyboardInset(800, 460, 100)).toBe(240);
  });

  it("ignores the browser's own bars", () => {
    expect(keyboardInset(800, 744, 0)).toBe(0);
  });

  it("ignores pinch zoom", () => {
    expect(keyboardInset(800, 400, 0, 2)).toBe(0);
  });
});

describe("scrollAfterZoom", () => {
  it("keeps the point under the fingers where it is", () => {
    // 300px into the content, 100px from the edge: at twice the size it is 600px in.
    expect(scrollAfterZoom(300, 1, 2, 100)).toBe(500);
    expect(scrollAfterZoom(300, 1, 0.5, 100)).toBe(50);
  });

  it("never goes before the start of the content", () => {
    expect(scrollAfterZoom(50, 1, 0.5, 100)).toBe(0);
  });
});
