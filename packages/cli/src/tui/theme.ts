// Central CLI palette — clean blue / white / black. Ink 5 renders hex colors; blue (#3b82f6) is the
// brand accent, white = primary text, gray = secondary. Semantic green/amber/red are kept ONLY for
// status (severity, regression, op glyphs, connection, score health) so the signal that helps you
// read the screen survives the retheme. Every use is gated by NO_COLOR at the call site (the `tc`
// helper, or `color={noColor ? undefined : …}`).

export const theme = {
  accent: "#3b82f6", // blue — active phase, keybindings, filter, selection, brand wordmark, rename op
  good: "#22c55e", // green — done/complete, improvement, add op, connected, NEW finding
  warn: "#f59e0b", // amber — change op, medium severity, connecting, advisory, no-data, queued/notice
  bad: "#ef4444", // red — delete op, high severity, regression, error, low score
  crit: "#e11d48", // rose — critical severity (a touch deeper than `bad`)
  dim: "gray", // labels, metadata, separators, pending phases
} as const;

// Resolve a themed color honoring NO_COLOR (undefined → Ink renders the text without color).
export function tc(noColor: boolean, color: string | undefined): string | undefined {
  return noColor ? undefined : color;
}
