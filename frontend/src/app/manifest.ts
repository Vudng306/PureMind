import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PureMind",
    short_name: "PureMind",
    description: "Đọc tài liệu, highlight và ghi chú.",
    start_url: "/library",
    scope: "/",
    display: "standalone",
    background_color: "#faf6ee",
    theme_color: "#faf6ee",
    icons: [
      { src: "/install-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/install-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
