import { describe, expect, it } from "vitest";

import { formatUsd, purposeLabel } from "./admin-costs";
import type { T } from "./i18n";

describe("formatUsd", () => {
  it("shows as many decimals as the amount needs", () => {
    expect(formatUsd(0, "en")).toBe("$0.00");
    expect(formatUsd(12.345, "en")).toBe("$12.35");
    expect(formatUsd(0.0312, "en")).toBe("$0.0312");
    expect(formatUsd(0.000042, "en")).toBe("$0.000042");
  });

  it("does not round a tiny cost down to nothing", () => {
    expect(formatUsd(0.0000002, "en")).toBe("< $0.000001");
  });
});

describe("purposeLabel", () => {
  const t = ((key: string) => `[${key}]`) as T;

  it("names the known features and shows any other as it is", () => {
    expect(purposeLabel("reader_deep", t)).toBe("[cost.purpose.reader_deep]");
    expect(purposeLabel("something_new", t)).toBe("something_new");
  });
});
