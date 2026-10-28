import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Engine-less Prisma (engineType "client") loads query_compiler_bg.wasm at
  // runtime; Vercel's file tracing misses it, so ship it with every function.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.prisma/client/*.wasm"],
  },
};

export default nextConfig;
