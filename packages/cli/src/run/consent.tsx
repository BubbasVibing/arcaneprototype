import { Box, render, Text, useApp, useInput } from "ink";
import type { ReactElement } from "react";

// M3D-2 — the per-run permission prompt (§19.1 gate 3), modeled on Claude Code's allow-once/always/
// deny flow. This is UX ONLY: the human's keypress becomes the `consent` signal the CLI sends; the
// CLOUD is the authority that actually gates execution. We show the DECLARED command so the human
// sees exactly what they're authorizing — and label it "runs in the cloud", never on this machine
// (the CLI never executes user code, §16.1). Reuses the watch TUI's ink + useInput pattern.

export type ConsentChoice = "once" | "session" | "always" | "deny";

export interface ConsentPromptProps {
  workload: string;
  command: string; // the declared [[workload]].command, shown for an informed grant
  baselineRef: string;
  currentRef: string;
  noColor: boolean;
  onChoose: (choice: ConsentChoice) => void;
}

function ConsentPrompt(props: ConsentPromptProps): ReactElement {
  const { exit } = useApp();
  const dim = props.noColor ? undefined : "gray";
  const accent = props.noColor ? undefined : "yellow";

  useInput((input, key) => {
    const c = input.toLowerCase();
    // Any exit-ish key (deny, escape, ctrl-c) fails CLOSED — no run without an explicit allow.
    let choice: ConsentChoice | undefined;
    if (c === "o") choice = "once";
    else if (c === "s") choice = "session";
    else if (c === "a") choice = "always";
    else if (c === "d" || key.escape || (key.ctrl && c === "c")) choice = "deny";
    if (choice) {
      props.onChoose(choice);
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={accent}>
        ⚠ arcane run — execution consent
      </Text>
      <Box>
        <Text color={dim}>{"  workload  "}</Text>
        <Text bold>{props.workload}</Text>
      </Box>
      <Box>
        <Text color={dim}>{"  command   "}</Text>
        <Text>{props.command}</Text>
        <Text color={dim}>{"   (runs in the cloud sandbox, never on your machine)"}</Text>
      </Box>
      <Box>
        <Text color={dim}>{"  compare   "}</Text>
        <Text>
          {props.baselineRef} → {props.currentRef}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold>[o]</Text> allow once {"  "}
          <Text bold>[s]</Text> allow this session {"  "}
          <Text bold>[a]</Text> always allow {"  "}
          <Text bold>[d]</Text> deny
        </Text>
      </Box>
    </Box>
  );
}

// Render the prompt and resolve with the human's choice. Defaults to "deny" if the UI exits without a
// choice (e.g. ctrl-c / the stream closing) — absence of a decision is never treated as consent.
// Caller MUST only invoke this with a real TTY (ink needs raw mode); the headless path never prompts.
export async function promptConsent(
  opts: Omit<ConsentPromptProps, "onChoose">,
): Promise<ConsentChoice> {
  return new Promise<ConsentChoice>((resolve) => {
    let chosen: ConsentChoice = "deny"; // fail closed
    const instance = render(<ConsentPrompt {...opts} onChoose={(c) => (chosen = c)} />);
    void instance.waitUntilExit().then(() => resolve(chosen));
  });
}
