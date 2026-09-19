import type { Config } from "tailwindcss";

const withVar = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
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
        "on-accent": withVar("on-accent"),
        menu: withVar("menu"),
        "menu-fg": withVar("menu-fg"),
        danger: withVar("danger"),
        "danger-soft": withVar("danger-soft"),
        success: withVar("success"),
        "success-soft": withVar("success-soft"),
      },
      fontFamily: {
        serif: ["var(--font-serif)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
      maxWidth: { reading: "760px" },
      boxShadow: {
        float: "0 12px 32px rgb(var(--shadow) / var(--shadow-alpha))",
        pop: "0 28px 70px rgb(0 0 0 / 0.30)",
      },
      keyframes: {
        "pm-slide": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(260%)" } },
      },
      animation: { "pm-slide": "pm-slide 1.4s ease-in-out infinite" },
    },
  },
  plugins: [],
} satisfies Config;
