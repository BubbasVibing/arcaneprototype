import { Box, Text } from "ink";
import type { ConnState } from "../../transport/ws-client";
import { theme } from "../theme";

// Status line: socket connection, the active filter, the most recent "not available" notice, and
// the sign-in hint (L). Sign-in itself is M1B (§27) — the key renders but reports not-available.

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting…",
  open: "connected",
  closed: "disconnected",
  error: "error",
};

const CONN_COLOR: Record<ConnState, string> = {
  connecting: theme.warn,
  open: theme.good,
  closed: "gray",
  error: theme.bad,
};

export function Footer({
  conn,
  journalDepth,
  resync,
  filtering,
  filter,
  notice,
  noColor,
}: {
  conn: ConnState;
  journalDepth: number;
  resync: boolean;
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
        {resync ? (
          <Text color={noColor ? undefined : theme.accent}>{"  "}resyncing…</Text>
        ) : null}
        {journalDepth > 0 ? (
          <Text color={noColor ? undefined : theme.warn}>
            {"  "}
            {conn === "open" ? "unacked" : "queued"}: {journalDepth}
          </Text>
        ) : null}
        {filtering || filter ? (
          <Text color={dim}>
            {"  "}filter: <Text color={noColor ? undefined : theme.accent}>{filter || "…"}</Text>
            {filtering ? "▌" : ""}
          </Text>
        ) : null}
        {notice ? <Text color={noColor ? undefined : theme.warn}>{"  "}{notice}</Text> : null}
      </Box>
      <Text color={dim}>[L] sign-in · [?] help · [q] quit</Text>
    </Box>
  );
}
