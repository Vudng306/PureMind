import type { Metadata, Viewport } from "next";
import { Be_Vietnam_Pro, Newsreader } from "next/font/google";

import { Providers } from "@/components/providers";

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
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf6ee" },
    { media: "(prefers-color-scheme: dark)", color: "#17140f" },
  ],
};

// Apply the saved theme and language before first paint to avoid a flash.
const themeScript = `try{var p=(JSON.parse(localStorage.getItem("puremind-preferences")||"{}").state)||{};var d=document.documentElement;d.dataset.theme=p.theme==="dark"?"dark":"light";d.lang=p.language||"vi"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning className={`${serif.variable} ${sans.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
