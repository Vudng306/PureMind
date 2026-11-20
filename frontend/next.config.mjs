/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  // Addresses of parts PureMind no longer has lead to what took their place.
  async redirects() {
    return [
      { source: "/feed/:path*", destination: "/explore", permanent: false },
      { source: "/community/:path*", destination: "/explore", permanent: false },
      { source: "/publish/:path*", destination: "/library", permanent: false },
      { source: "/admin/posts", destination: "/admin", permanent: false },
      { source: "/admin/articles", destination: "/admin", permanent: false },
      { source: "/admin/crawl", destination: "/admin", permanent: false },
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
