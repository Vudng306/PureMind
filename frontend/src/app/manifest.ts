import type { MetadataRoute } from "next";

import { THEME_COLOR } from "@/lib/theme-color";

/** What a phone needs to keep PureMind on its home screen and open it without the browser's bars. There is
 * deliberately no service worker: a reader's documents and notes are not left in a cache on the device. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "PureMind",
    short_name: "PureMind",
    description: "Không gian yên tĩnh để đọc, suy nghĩ và lưu giữ ý tưởng.",
    lang: "vi",
    start_url: "/library",
    scope: "/",
    display: "standalone",
    background_color: THEME_COLOR.light,
    theme_color: THEME_COLOR.light,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
