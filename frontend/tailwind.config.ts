import type { Config } from "tailwindcss";

const withVar = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

// Colours, radii and shadows follow the PureMind Design System v1 (tokens in src/app/globals.css).
export default {
  content: ["./src/**/*.{ts,tsx}"],
  // A tap must not leave a button looking hovered on a touch screen.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      colors: {
        bg: withVar("bg"),
        surface: withVar("surface"),
        ink: withVar("ink"),
        body: withVar("body"),
        muted: withVar("muted"),
        line: withVar("line"),
        field: withVar("field"),
        soft: withVar("soft"),
        page: withVar("page"),
        accent: withVar("accent"),
        "accent-hover": withVar("accent-hover"),
        "accent-pressed": withVar("accent-pressed"),
        "accent-text": withVar("accent-text"),
        "accent-soft": withVar("accent-soft"),
        "accent-on-soft": withVar("accent-on-soft"),
        tone: withVar("tone"),
        "tone-bg": withVar("tone-bg"),
        "tone-fg": withVar("tone-fg"),
        "on-accent": withVar("on-accent"),
        focus: withVar("focus"),
        menu: withVar("menu"),
        "menu-fg": withVar("menu-fg"),
        danger: withVar("danger"),
        "danger-soft": withVar("danger-soft"),
        "on-danger": withVar("on-danger"),
        success: withVar("success"),
        "success-soft": withVar("success-soft"),
        warning: withVar("warning"),
        "warning-soft": withVar("warning-soft"),
        highlight: withVar("highlight"),
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Georgia", "Times New Roman", "serif"],
        sans: ["var(--font-sans)", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        // Headings use the same serif as reading text (Newsreader); kept as its own name for the call sites.
        display: ["var(--font-serif)", "Georgia", "serif"],
      },
      maxWidth: { reading: "740px", container: "1280px" },
      boxShadow: {
        card: "var(--shadow-card)",
        raised: "var(--shadow-raised)",
        float: "var(--shadow-raised)",
        pop: "var(--shadow-raised)",
      },
      keyframes: {
        "pm-slide": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(260%)" } },
      },
      animation: { "pm-slide": "pm-slide 1.4s ease-in-out infinite" },
    },
  },
  plugins: [],
} satisfies Config;
