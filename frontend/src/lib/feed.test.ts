import { describe, expect, it } from "vitest";

import { readingMinutes, resumeAt, shortCards, shortMinutes } from "./feed";

describe("readingMinutes", () => {
  it("rounds to whole minutes at about 220 words a minute", () => {
    expect(readingMinutes(1100)).toBe(5);
    expect(readingMinutes(1210)).toBe(6);
  });
  it("is never under a minute", () => {
    expect(readingMinutes(0)).toBe(1);
  });
});

describe("shortCards", () => {
  const text = { title: "Vì sao?", hook: "Mở đầu.", points: ["Một.", "Hai."], takeaway: "Kết." };

  it("gives one card to each idea, however many there are", () => {
    expect(shortCards(text).map((c) => c.role)).toEqual(["hook", "insight", "insight", "takeaway"]);
    expect(shortCards({ ...text, points: ["1", "2", "3", "4"] })).toHaveLength(6);
  });
  it("opens on the title and its hook, and numbers the points", () => {
    expect(shortCards(text)[0]).toEqual({ role: "hook", title: "Vì sao?", body: "Mở đầu." });
    expect(shortCards(text)[2]).toEqual({ role: "insight", point: 2, body: "Hai." });
  });
});

describe("shortMinutes", () => {
  it("is never under a minute", () => {
    expect(shortMinutes({ title: "a", hook: "b", points: [], takeaway: "c" })).toBe(1);
  });
  it("counts every card", () => {
    const words = Array(600).fill("từ").join(" ");
    expect(shortMinutes({ title: "", hook: words, points: [], takeaway: "" })).toBe(3);
  });
});

describe("resumeAt", () => {
  it("opens where the reader stopped", () => {
    expect(resumeAt({ card_index: 3, completed: false, total_cards: 6 })).toBe(3);
  });
  it("opens a finished short from its start", () => {
    expect(resumeAt({ card_index: 5, completed: true, total_cards: 6 })).toBe(0);
  });
  it("stays within the cards there are, should a short have been rewritten shorter", () => {
    expect(resumeAt({ card_index: 9, completed: false, total_cards: 5 })).toBe(4);
  });
});
