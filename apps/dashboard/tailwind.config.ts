import type { Config } from "tailwindcss";

// Arcane dashboard theme — clean blue / white / black (light). Brand accent is blue-600; semantic
// red/green are kept only for status (regression, severity, deltas). Fonts come from next/font via
// CSS variables set on <html> (app/layout.tsx).
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        brand: {
          DEFAULT: "#2563eb", // blue-600
          fg: "#1d4ed8", // blue-700
          tint: "#eff6ff", // blue-50
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
