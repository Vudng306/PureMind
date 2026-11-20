import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro, Newsreader } from "next/font/google";

import { Providers } from "@/components/providers";
import { THEME_COLOR } from "@/lib/theme-color";

import "./globals.css";

// Design System v1: Newsreader (serif) for headings, card titles and long reading; Be Vietnam Pro for the UI.
const serif = Newsreader({
  subsets: ["latin", "vietnamese"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});
const sans = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PureMind",
  description: "Không gian yên tĩnh để đọc, suy nghĩ và lưu giữ ý tưởng.",
  applicationName: "PureMind",
  // Added to an iPhone's home screen, it opens without Safari's bars, below the status bar.
  appleWebApp: { capable: true, title: "PureMind", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The page may reach under a notch (globals.css keeps the content clear of it), and on Android the keyboard
  // shrinks the page instead of covering it.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

// Apply the saved theme and language before first paint to avoid a flash. The browser's bar follows the theme
// chosen here, not the phone's own setting.
const themeScript = `try{var p=(JSON.parse(localStorage.getItem("puremind-preferences")||"{}").state)||{};var d=document.documentElement;var t=p.theme==="dark"?"dark":"light";d.dataset.theme=t;d.lang=p.language||"vi";var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=${JSON.stringify(THEME_COLOR)}[t]}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning className={`${serif.variable} ${sans.variable}`}>
      <head>
        <meta name="theme-color" content={THEME_COLOR.light} suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
