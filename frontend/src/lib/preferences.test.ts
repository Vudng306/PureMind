import { describe, expect, it } from "vitest";

import { colorLabel, usePreferences } from "./preferences";

describe("reading preferences from the account", () => {
  it("takes the typeface and the reading page, and keeps what the account does not say", () => {
    const { applyServer } = usePreferences.getState();
    applyServer({ font_family: "sans", reading_theme: "sepia" });
    expect(usePreferences.getState()).toMatchObject({ fontFamily: "sans", readingTheme: "sepia", fontSize: 19 });
    applyServer({ font_size: 21 });
    expect(usePreferences.getState()).toMatchObject({ fontFamily: "sans", readingTheme: "sepia", fontSize: 21 });
  });

  it("keeps the choice to hide the time left (RD-112)", () => {
    const { applyServer } = usePreferences.getState();
    expect(usePreferences.getState().timeLeft).toBe(true);
    applyServer({ time_left: false });
    expect(usePreferences.getState().timeLeft).toBe(false);
    applyServer({ font_size: 19 });
    expect(usePreferences.getState().timeLeft).toBe(false);
  });

  it("reads null as following the theme of the app again", () => {
    const { applyServer } = usePreferences.getState();
    applyServer({ reading_theme: "dark" });
    applyServer({ reading_theme: null });
    expect(usePreferences.getState().readingTheme).toBeNull();
  });
});

const unnamed = { yellow: "", green: "", blue: "", pink: "", purple: "" };

describe("colorLabel", () => {
  it("says what an unnamed color means, in the chosen language", () => {
    expect(colorLabel(unnamed, "yellow", "vi")).toBe("Ý chính");
    expect(colorLabel(unnamed, "pink", "en")).toBe("Unclear");
  });

  it("prefers the reader's own name for a color", () => {
    expect(colorLabel({ ...unnamed, blue: " Công thức " }, "blue", "vi")).toBe("Công thức");
  });
});
