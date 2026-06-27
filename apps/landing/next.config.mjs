import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to the monorepo root (where deps are hoisted by the
  // npm workspace), so Turbopack does not infer it from a stray lockfile higher
  // up the filesystem.
  turbopack: {
    root: resolve(__dirname, "../.."),
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
