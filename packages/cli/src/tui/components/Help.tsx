import { Box, Text } from "ink";

// '?' overlay. Mirrors the §8 M1 keybinding scope: only keys for features that exist in M1A are
// active; keys for not-yet-built features render but report "not available in this milestone".

export function Help({ noColor }: { noColor: boolean }) {
  const dim = noColor ? undefined : "gray";
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>KEYS</Text>
      <Text>
        <Text color={noColor ? undefined : "cyan"}>j/k</Text> move ·{" "}
        <Text color={noColor ? undefined : "cyan"}>enter</Text> expand ·{" "}
        <Text color={noColor ? undefined : "cyan"}>d</Text> scores ·{" "}
        <Text color={noColor ? undefined : "cyan"}>/</Text> filter ·{" "}
        <Text color={noColor ? undefined : "cyan"}>?</Text> help ·{" "}
        <Text color={noColor ? undefined : "cyan"}>q</Text> quit
      </Text>
      <Text color={dim}>
        L active later · e f a g b r $ — not available in this milestone
      </Text>
    </Box>
  );
}
