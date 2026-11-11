/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // The feed and the community are out of the interface (src/lib/features.ts): their addresses lead to what
  // stays. /feed/read/:id is not the feed but an article's own page, and keeps working.
  async redirects() {
    return [
      { source: "/feed", destination: "/explore", permanent: false },
      { source: "/community/:path*", destination: "/explore", permanent: false },
      { source: "/publish/:path*", destination: "/library", permanent: false },
      { source: "/admin/posts", destination: "/admin", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
