import ts from "typescript";
import type { Finding, Range, Severity } from "@arcane/shared";
import { parse, rangeOf } from "./ts-ast";
import { findingId, type Analyzer, type AnalyzerInput } from "./types";

// Escape-hatch analyzer (plan M1C/D1, dimension `types`). Flags TypeScript type-safety escape
// hatches: the `any` type, `as` assertions (except `as const`), and the `@ts-ignore` /
// `@ts-expect-error` / `@ts-nocheck` directive comments. AST for `any`/`as` (robust, pure-JS via
// the TS compiler API, D4); a line scan for the directive comments (they live in trivia).

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const DIRECTIVE = /@ts-(ignore|expect-error|nocheck)\b/;

export function makeEscapeHatchAnalyzer(): Analyzer {
  return {
    name: "escape-hatch",
    handles: (path) => TS_EXT.test(path) && !path.endsWith(".d.ts"),
    analyze({ path, content }: AnalyzerInput): Finding[] {
      const sf = parse(path, content);
      const findings: Finding[] = [];
      const push = (ruleId: string, severity: Severity, message: string, range: Range): void => {
        findings.push({
          id: findingId(ruleId, path, range),
          dimension: "types",
          severity,
          ruleId,
          message,
          file: path,
          range,
          fixable: false,
        });
      };

      const walk = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.AnyKeyword) {
          push("escape-hatch/no-any", "low", "`any` type defeats the type checker", rangeOf(sf, node));
        } else if (ts.isAsExpression(node)) {
          const typeText = node.type.getText(sf);
          if (typeText !== "const") {
            push(
              "escape-hatch/no-as",
              "low",
              `type assertion \`as ${typeText}\` bypasses the type checker`,
              rangeOf(sf, node),
            );
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);

      // `@ts-*` directives live in comments (not the AST) — scan lines.
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const m = DIRECTIVE.exec(line);
        if (!m) continue;
        const kind = m[1] ?? "ignore";
        const col = line.indexOf("@ts-") + 1;
        push(`escape-hatch/ts-${kind}`, "medium", `\`@ts-${kind}\` suppresses type errors`, {
          startLine: i + 1,
          startCol: col,
          endLine: i + 1,
          endCol: col + m[0].length,
        });
      }
      return findings;
    },
  };
}

export const escapeHatchAnalyzer = makeEscapeHatchAnalyzer();
