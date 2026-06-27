import type { Score } from "@arcane/shared";
import { Box, Text } from "ink";
import { theme } from "../theme";

// Per-dimension score bars (M1C — toggled by `d`, §8). Each bar is 0–100 rendered in block cells,
// colored by value (amber/red thresholds, Requirements §4.1 "bar turns amber/red"), with the signed
// delta vs the previous snapshot. Pure render from the store's `scores` (the cloud does the math).

const WIDTH = 20;

function barColor(value: number, noColor: boolean): string | undefined {
  if (noColor) return undefined;
  if (value < 50) return theme.bad;
  if (value < 70) return theme.warn;
  return theme.accent;
}

export function Scores({ scores, noColor }: { scores: Score[]; noColor: boolean }) {
  const dim = noColor ? undefined : "gray";
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        SCORES <Text color={dim}>(d to toggle)</Text>
      </Text>
      {scores.length === 0 ? (
        <Text color={dim}>analyzing… scores appear after the first change</Text>
      ) : (
        scores.map((s) => {
          const value = Math.round(s.value);
          const filled = Math.round((s.value / 100) * WIDTH);
          const bar = "█".repeat(filled) + "░".repeat(WIDTH - filled);
          const delta = s.delta === 0 ? "" : ` ${s.delta > 0 ? "+" : ""}${s.delta.toFixed(0)}`;
          const deltaColor = noColor ? undefined : s.delta > 0 ? theme.good : s.delta < 0 ? theme.bad : "gray";
          return (
            <Text key={s.dimension}>
              <Text color={dim}>{s.dimension.padEnd(12)}</Text>
              <Text color={barColor(s.value, noColor)}>{bar}</Text>
              <Text> {String(value).padStart(3)}</Text>
              <Text color={deltaColor}>{delta}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}
