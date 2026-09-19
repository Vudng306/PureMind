import { describe, expect, it } from "vitest";

import { citedPositions, readEvents } from "./notebooks";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("readEvents", () => {
  it("splits events even when a chunk ends mid-event or mid-character", async () => {
    const whole = 'event: delta\ndata: {"text":"Xin chào"}\n\nevent: done\ndata: {"id":"n1"}\n\n';
    const bytes = new TextEncoder().encode(whole);
    const cut = whole.indexOf("chào") + 2; // inside the multi-byte "à"
    const parts = [bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        parts.forEach((p) => c.enqueue(p));
        c.close();
      },
    });
    const got = [];
    for await (const e of readEvents(body)) got.push(e);
    expect(got).toEqual([
      { event: "delta", data: '{"text":"Xin chào"}' },
      { event: "done", data: '{"id":"n1"}' },
    ]);
  });

  it("ignores blocks without data", async () => {
    const got = [];
    for await (const e of readEvents(streamOf([": ping\n\n", "data: 1\n\n"]))) got.push(e);
    expect(got).toEqual([{ event: "message", data: "1" }]);
  });
});

describe("citedPositions", () => {
  it("lists [n] references once, in order of first use", () => {
    expect(citedPositions("a [2] b [10][2] c [x] [1]")).toEqual([2, 10, 1]);
  });
});
