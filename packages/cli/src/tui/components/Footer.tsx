import { Box, Text } from "ink";
import type { ConnState } from "../../transport/ws-client";

// Status line: socket connection, the active filter, the most recent "not available" notice, and
// the sign-in hint (L). Sign-in itself is M1B (§27) — the key renders but reports not-available.

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting…",
  open: "connected",
  closed: "disconnected",
  error: "error",
};

const CONN_COLOR: Record<ConnState, string> = {
  connecting: "yellow",
  open: "green",
  closed: "gray",
  error: "red",
};

export function Footer({
  conn,
  filtering,
  filter,
  notice,
  noColor,
}: {
  conn: ConnState;
  filtering: boolean;
  filter: string;
  notice: string | null;
  noColor: boolean;
}) {
  const dim = noColor ? undefined : "gray";
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color={noColor ? undefined : CONN_COLOR[conn]}>● {CONN_LABEL[conn]}</Text>
        {filtering || filter ? (
          <Text color={dim}>
            {"  "}filter: <Text color={noColor ? undefined : "cyan"}>{filter || "…"}</Text>
            {filtering ? "▌" : ""}
          </Text>
        ) : null}
        {notice ? <Text color={noColor ? undefined : "yellow"}>{"  "}{notice}</Text> : null}
      </Box>
      <Text color={dim}>[L] sign-in · [?] help · [q] quit</Text>
    </Box>
  );
}
