import { Box, Text } from "ink";
import { theme } from "../theme";

// '?' overlay. Mirrors the §8 M1 keybinding scope: only keys for features that exist in M1A are
// active; keys for not-yet-built features render but report "not available in this milestone".

export function Help({ noColor }: { noColor: boolean }) {
  const dim = noColor ? undefined : "gray";
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>KEYS</Text>
      <Text>
        <Text color={noColor ? undefined : theme.accent}>j/k</Text> move ·{" "}
        <Text color={noColor ? undefined : theme.accent}>enter</Text> expand ·{" "}
        <Text color={noColor ? undefined : theme.accent}>d</Text> scores ·{" "}
        <Text color={noColor ? undefined : theme.accent}>/</Text> filter ·{" "}
        <Text color={noColor ? undefined : theme.accent}>?</Text> help ·{" "}
        <Text color={noColor ? undefined : theme.accent}>q</Text> quit
      </Text>
      <Text color={dim}>
        L active later · e f a g b r $ — not available in this milestone
      </Text>
    </Box>
  );
}
