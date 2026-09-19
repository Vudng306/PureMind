import type { Metadata } from "next";
import { IBM_Plex_Sans, Source_Serif_4 } from "next/font/google";

import { Providers } from "@/components/providers";

import "./globals.css";

const serif = Source_Serif_4({ subsets: ["latin", "vietnamese"], variable: "--font-serif", display: "swap" });
const sans = IBM_Plex_Sans({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PureMind",
  description: "Không gian yên tĩnh để đọc, suy nghĩ và lưu giữ ý tưởng.",
};

// Apply the saved theme before first paint to avoid a flash.
const themeScript = `try{var p=JSON.parse(localStorage.getItem("puremind-preferences")||"{}");document.documentElement.dataset.theme=(p.state&&p.state.theme)||"light"}catch(e){}`;

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
