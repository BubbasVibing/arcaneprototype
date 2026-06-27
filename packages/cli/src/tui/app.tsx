import { Box, Text, useApp, useInput } from "ink";
import { useState, useSyncExternalStore } from "react";
import { ChangeLog } from "./components/ChangeLog";
import { Findings } from "./components/Findings";
import { Footer } from "./components/Footer";
import { Help } from "./components/Help";
import { PipelineState } from "./components/PipelineState";
import { Scores } from "./components/Scores";
import type { Store } from "./store";

// Root Ink component. Renders the session pipeline stepper, per-dimension score bars (`d`), the
// findings list, and the ordered change log, wiring the §8 keybindings. Keys for not-yet-built
// features render but report "not available in this milestone". Honors NO_COLOR via `noColor`.

export interface AppProps {
  store: Store;
  noColor: boolean;
  onQuit: () => void;
}

// Keys whose features don't exist yet — they render the action but are gated (§8). `d` is now live
// (toggles the score panel, handled below), so it left this list in M1C.
const NOT_AVAILABLE: Record<string, string> = {
  L: "sign-in",
  e: "explain (AI)",
  f: "verified fix",
  a: "apply fix",
  g: "git tree",
  b: "baseline",
  r: "re-run",
  $: "spend",
};

export function App({ store, noColor, onQuit }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = filter
    ? state.events.filter(
        (e) => e.path.includes(filter) || (e.oldPath?.includes(filter) ?? false),
      )
    : state.events;
  const sel = Math.min(selected, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    // Filter-input mode: capture typing until enter/escape.
    if (filtering) {
      if (key.return || key.escape) {
        setFiltering(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((f) => f.slice(0, -1));
        return;
      }
      if (input) setFilter((f) => f + input);
      return;
    }

    if (helpOpen) {
      if (input === "?" || key.escape) setHelpOpen(false);
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      onQuit();
      exit();
      return;
    }
    if (input === "?") {
      setNotice(null);
      setHelpOpen(true);
      return;
    }
    if (input === "/") {
      setNotice(null);
      setFilter("");
      setFiltering(true);
      return;
    }
    if (input === "j" || key.downArrow) {
      setNotice(null);
      setSelected((s) => Math.min(s + 1, Math.max(0, filtered.length - 1)));
      return;
    }
    if (input === "k" || key.upArrow) {
      setNotice(null);
      setSelected((s) => Math.max(s - 1, 0));
      return;
    }
    if (key.return) {
      setNotice(null);
      setExpanded((e) => !e);
      return;
    }
    if (input === "d") {
      setNotice(null);
      store.toggleScores(); // §8 — show/hide the per-dimension score bars
      return;
    }

    const na = NOT_AVAILABLE[input];
    if (na) setNotice(`${na}: not available in this milestone`);
  });

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold>arcane</Text>
        <Text color={noColor ? undefined : "gray"}>
          {"  "}watch · {state.root}
        </Text>
      </Box>
      <PipelineState phase={state.phase} noColor={noColor} />
      {state.showScores ? <Scores scores={state.scores} noColor={noColor} /> : null}
      <Findings findings={state.findings} noColor={noColor} />
      <ChangeLog events={filtered} selected={sel} expanded={expanded} noColor={noColor} />
      {helpOpen ? <Help noColor={noColor} /> : null}
      <Footer
        conn={state.conn}
        journalDepth={state.journalDepth}
        resync={state.resync}
        filtering={filtering}
        filter={filter}
        notice={notice}
        noColor={noColor}
      />
    </Box>
  );
}
