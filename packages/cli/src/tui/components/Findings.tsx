import type { Severity } from "@arcane/shared";
import { Box, Text } from "ink";
import type { FindingRow } from "../store";

// The findings list (M1C). One row per finding from the latest analysis frame: severity, dimension,
// a NEW tag (is_new vs the previous snapshot), location, and the message. Pure render from the
// store's `findings`.

const SEVERITY_COLOR: Record<Severity, string> = {
  info: "gray",
  low: "cyan",
  medium: "yellow",
  high: "red",
  critical: "magenta",
};

const MAX_ROWS = 10;

export function Findings({ findings, noColor }: { findings: FindingRow[]; noColor: boolean }) {
  const dim = noColor ? undefined : "gray";
  const shown = findings.slice(0, MAX_ROWS);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>
        FINDINGS <Text color={dim}>({findings.length})</Text>
      </Text>
      {findings.length === 0 ? (
        <Text color={dim}>no findings — edit a file to run the analyzers</Text>
      ) : (
        shown.map((f) => {
          const loc = f.range ? `${f.file}:${f.range.startLine}` : f.file;
          return (
            <Text key={f.id}>
              <Text color={noColor ? undefined : SEVERITY_COLOR[f.severity]}>
                {f.severity.padEnd(9)}
              </Text>
              <Text color={dim}>{f.dimension.padEnd(11)}</Text>
              {f.isNew ? <Text color={noColor ? undefined : "green"}>NEW </Text> : null}
              <Text>{loc} </Text>
              <Text color={dim}> {f.message}</Text>
            </Text>
          );
        })
      )}
      {findings.length > MAX_ROWS ? (
        <Text color={dim}>… {findings.length - MAX_ROWS} more</Text>
      ) : null}
    </Box>
  );
}
