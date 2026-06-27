import type { ResultPhase } from "@arcane/shared";
import { Box, Text } from "ink";
import { theme } from "../theme";

// The session pipeline stepper. The `state` ResultEvent is session-scoped (no changeId — M1A
// decision #2), so this shows ONE current phase for the whole session, advancing as the cloud
// streams `state` events. This is what makes a round-trip legible instead of reading as a hang.

const PHASES: ResultPhase[] = ["detected", "uploading", "queued", "analyzing", "results", "done"];

export function PipelineState({
  phase,
  noColor,
}: {
  phase: ResultPhase | null;
  noColor: boolean;
}) {
  const activeIdx = phase ? PHASES.indexOf(phase) : -1;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>PIPELINE (session)</Text>
      <Box>
        {PHASES.map((p, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          const symbol = active ? "●" : done ? "✓" : "○";
          const color = noColor ? undefined : active ? theme.accent : done ? theme.good : "gray";
          return (
            <Text key={p} color={color}>
              {symbol} {p}
              {i < PHASES.length - 1 ? <Text color={noColor ? undefined : "gray"}>{"  →  "}</Text> : null}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
