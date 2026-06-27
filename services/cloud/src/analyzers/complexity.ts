import ts from "typescript";
import type { Finding, Severity } from "@arcane/shared";
import { parse, rangeOf } from "./ts-ast";
import { findingId, type Analyzer, type AnalyzerInput } from "./types";

// Complexity analyzer (plan M1C, dimension `complexity`). Computes per-function cyclomatic
// complexity from the TypeScript AST (the battle-tested, pure-JS, no-native-addon tool, per D4) and
// flags functions over `max_cyclomatic` (Requirements §4.1, default 15). Severity escalates with
// how far over the threshold a function is — that is M1C's realization of §6's "complexity max caps
// the bar" (the persistable Metric/`metrics` table is M2+, so the cap rides the severity weights).

const DEFAULT_MAX_CYCLOMATIC = 15;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const RULE_ID = "complexity/cyclomatic";

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

// Cyclomatic complexity = 1 + decision points inside the function, NOT descending into nested
// functions (each gets its own score).
function complexityOf(fn: ts.Node): number {
  let count = 1;
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return; // a nested function — its own scope, skip its subtree
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        count++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (node as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          count++;
        }
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit); // start at the body — we never count `fn` itself
  return count;
}

function functionName(node: ts.Node): string {
  const named = node as ts.NamedDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return `function '${named.name.text}'`;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return `function '${parent.name.text}'`;
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return `function '${parent.name.text}'`;
  }
  return "anonymous function";
}

function severityFor(complexity: number, max: number): Severity {
  if (complexity > max * 2) return "critical";
  if (complexity > max * 1.5) return "high";
  return "medium";
}

export function makeComplexityAnalyzer(maxCyclomatic = DEFAULT_MAX_CYCLOMATIC): Analyzer {
  return {
    name: "complexity",
    handles: (path) => SOURCE_EXT.test(path) && !path.endsWith(".d.ts"),
    analyze({ path, content }: AnalyzerInput): Finding[] {
      const sf = parse(path, content);
      const findings: Finding[] = [];
      const walk = (node: ts.Node): void => {
        if (isFunctionLike(node)) {
          const c = complexityOf(node);
          if (c > maxCyclomatic) {
            const range = rangeOf(sf, node);
            findings.push({
              id: findingId(RULE_ID, path, range),
              dimension: "complexity",
              severity: severityFor(c, maxCyclomatic),
              ruleId: RULE_ID,
              message: `${functionName(node)} has cyclomatic complexity ${c} (max ${maxCyclomatic})`,
              file: path,
              range,
              fixable: false,
              metadata: { cyclomatic: c, max: maxCyclomatic },
            });
          }
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      return findings;
    },
  };
}

export const complexityAnalyzer = makeComplexityAnalyzer();
