/** @type {import('next').NextConfig} */
const nextConfig = {
  reactCompiler: true,
  outputFileTracingExcludes: {
    "/*": ["./data/admin/**"],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "appwrite.nrep.ug",
        port: "",
        pathname: "/v1/storage/buckets/**",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/api/chat",
        headers: [
          {
            key: "X-Accel-Buffering",
            value: "no",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
