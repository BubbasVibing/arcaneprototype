/** @type {import('next').NextConfig} */
const nextConfig = {
  // @arcane/shared ships ESM + zod; transpile it through Next so the dashboard imports the SAME
  // ResultEvent types + reducer the terminal uses (no parallel web shapes — invariant 4).
  transpilePackages: ["@arcane/shared"],
};

export default nextConfig;
