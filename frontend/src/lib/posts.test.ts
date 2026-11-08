import { describe, expect, it } from "vitest";

import { MAX_CARD_BODY, MAX_POST_CARDS, splitIntoCards } from "./posts";

describe("splitIntoCards", () => {
  it("starts a card at each heading and drops the Markdown marks", () => {
    const { cards, dropped } = splitIntoCards(
      "# Mở đầu\n\nĐây là **ý chính** [1].\n\n## Vì sao\n\nVì [một nguồn](https://a.vn) nói vậy [2].",
    );
    expect(cards).toEqual([
      { heading: "Mở đầu", body: "Đây là ý chính." },
      { heading: "Vì sao", body: "Vì một nguồn nói vậy." },
    ]);
    expect(dropped).toBe(0);
  });

  it("runs a long passage onto the next card, at a sentence end, within the limit", () => {
    const sentence = "Một câu vừa đủ dài để thử việc cắt thẻ theo câu. ";
    const { cards } = splitIntoCards(sentence.repeat(40));
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      expect(card.body.length).toBeLessThanOrEqual(MAX_CARD_BODY);
      expect(card.body.endsWith(".")).toBe(true);
    }
  });

  it("cuts text with no sentence ends at a space", () => {
    const { cards } = splitIntoCards("từ ".repeat(500));
    for (const card of cards) expect(card.body.length).toBeLessThanOrEqual(MAX_CARD_BODY);
    expect(cards.map((c) => c.body).join(" ").split(" ")).toHaveLength(500);
  });

  it("says what did not fit rather than losing it quietly", () => {
    const text = Array.from({ length: 12 }, (_, i) => `## Phần ${i}\n\nNội dung ${i}.`).join("\n\n");
    const { cards, dropped } = splitIntoCards(text);
    expect(cards).toHaveLength(MAX_POST_CARDS);
    expect(dropped).toBe(3);
  });

  it("keeps quotes and list items as text", () => {
    const { cards } = splitIntoCards("> Một đoạn trích [3]\n\n- Ý một\n- Ý hai\n\n1. Ý ba");
    const text = cards.map((c) => c.body).join(" ");
    expect(text).toContain("Một đoạn trích");
    expect(text).toContain("Ý một");
    expect(text).toContain("Ý ba");
    expect(text).not.toMatch(/[>[\]]/);
  });

  it("gives each short paragraph its own card, so three paragraphs make a post", () => {
    const { cards } = splitIntoCards("Ý thứ nhất.\n\nÝ thứ hai.\n\nÝ thứ ba.");
    expect(cards.map((c) => c.body)).toEqual(["Ý thứ nhất.", "Ý thứ hai.", "Ý thứ ba."]);
  });

  it("lets short paragraphs share cards when one each would not fit", () => {
    const text = Array.from({ length: 14 }, (_, i) => `Đoạn số ${i}.`).join("\n\n");
    const { cards, dropped } = splitIntoCards(text);
    expect(cards.length).toBeLessThanOrEqual(MAX_POST_CARDS);
    expect(dropped).toBe(0);
    expect(cards[0].body).toContain("Đoạn số 13.");
  });

  it("gives nothing for nothing, and leaves out images", () => {
    expect(splitIntoCards("  \n\n")).toEqual({ cards: [], dropped: 0 });
    expect(splitIntoCards("![ảnh](https://a.vn/x.png)")).toEqual({ cards: [], dropped: 0 });
  });
});
