import type { ChangeEvent, ChangeOp } from "@arcane/shared";
import { Box, Text } from "ink";
import { theme } from "../theme";

// The ordered change log: one row per locally-emitted ChangeEvent (the CLI has its own
// seq/op/path — §3A.2). `enter` expands the selected row to show the wire fields the collector
// produced (hash, size, encoding, eventId). Per-change PHASE is intentionally absent — the
// `state` event is session-scoped (M1A decision #2).

const OP_GLYPH: Record<ChangeOp, string> = {
  add: "+",
  change: "~",
  delete: "-",
  rename: "→",
};

const OP_COLOR: Record<ChangeOp, string> = {
  add: theme.good,
  change: theme.warn,
  delete: theme.bad,
  rename: theme.accent,
};

const MAX_ROWS = 12;

export function ChangeLog({
  events,
  selected,
  expanded,
  noColor,
}: {
  events: ChangeEvent[];
  selected: number;
  expanded: boolean;
  noColor: boolean;
}) {
  // Keep the selected row in view as the log grows.
  let start = 0;
  if (events.length > MAX_ROWS) {
    start = Math.min(Math.max(0, selected - Math.floor(MAX_ROWS / 2)), events.length - MAX_ROWS);
  }
  const slice = events.slice(start, start + MAX_ROWS);

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
      <Text bold>
        CHANGES <Text color={noColor ? undefined : "gray"}>({events.length})</Text>
      </Text>
      {slice.length === 0 ? (
        <Text color={noColor ? undefined : "gray"}>watching… edit a file to see ordered events</Text>
      ) : (
        slice.map((ev, i) => {
          const idx = start + i;
          const isSel = idx === selected;
          const glyph = OP_GLYPH[ev.op];
          const opColor = noColor ? undefined : OP_COLOR[ev.op];
          const tail = ev.op === "rename" && ev.oldPath ? `  (from ${ev.oldPath})` : "";
          return (
            <Box key={ev.eventId} flexDirection="column">
              <Text inverse={isSel}>
                <Text color={noColor ? undefined : "gray"}>{String(ev.seq).padStart(3, " ")} </Text>
                <Text color={opColor}>{glyph}</Text> {ev.path}
                <Text color={noColor ? undefined : "gray"}>{tail}</Text>
              </Text>
              {isSel && expanded ? (
                <Text color={noColor ? undefined : "gray"}>
                  {"    "}
                  eventId={ev.eventId.slice(0, 8)} · hash={ev.contentHash ?? "—"} · size=
                  {ev.sizeBytes ?? "—"} · enc={ev.encoding ?? "—"}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Box>
  );
}
