// M3C — MINIMUM attribution (Technical-Spec §19A.1 Layer 3: SUPPORTING evidence only, never the
// headline). Scope-watch: the gate only needs "N+1 detected and attributed TO THE CHANGED FUNCTION",
// which is far simpler than a five-factor hotness ranking. So this rests on a CAUSAL ELIMINATION
// argument, not profiling:
//
//   the two trees are byte-identical except in the changed set, run under the same image / read-only
//   mounts / --network none / fixed env / fixtures → any DETERMINISTIC behavioral delta (here: extra
//   queries) MUST originate in the changed set.
//
// So we name the changed function(s) by parsing the CURRENT file and mapping the CURRENT changed line
// ranges to their enclosing function (the regression lives in current). One changed function → high
// confidence; several → list as suspects at medium. The probe's `functions` array stays empty — no
// per-function profiling, no probe change (deferred). The determinism PREMISE is verified empirically
// by the caller (delta-engine) before this is trusted; this module assumes it holds.

import ts from "typescript";
import type { Range, RunAttribution } from "@arcane/shared";
import { parse, rangeOf } from "../analyzers/ts-ast";
import { changedRanges } from "./worktrees";
import type { LineRange } from "./worktrees";

export const RULE_N_PLUS_ONE = "runtime/n-plus-one";

export interface ChangedFile {
  path: string; // repo-relative POSIX
  baselineText: string | undefined; // undefined ⇒ file added in current
  currentText: string;
}

export interface SuspectFunction {
  file: string;
  functionName?: string; // absent ⇒ module-scope / unresolved
  range?: Range; // the enclosing function's span in CURRENT coordinates
}

function isCodeFile(path: string): boolean {
  return /\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(path);
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function enclosingClassName(node: ts.Node): string | undefined {
  let p: ts.Node | undefined = node.parent;
  while (p) {
    if ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name) return p.name.text;
    p = p.parent;
  }
  return undefined;
}

// A human-meaningful name for a function-like node, or null if it is genuinely anonymous (e.g. an
// inline arrow passed to forEach). Resolves arrows/expressions through their binding context.
function nameOfFunctionLike(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? null;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const m = node.name?.getText(sf);
    if (!m) return null;
    const cls = enclosingClassName(node);
    return cls ? `${cls}.${m}` : m;
  }
  if (ts.isConstructorDeclaration(node)) {
    const cls = enclosingClassName(node);
    return cls ? `${cls}.constructor` : "constructor";
  }
  // FunctionExpression / ArrowFunction — name from the binding it is attached to.
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
  if (p && ts.isPropertyDeclaration(p) && p.name) return p.name.getText(sf);
  if (
    p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === node
  ) {
    return p.left.getText(sf);
  }
  return null;
}

function spanLines(node: ts.Node, sf: ts.SourceFile): number {
  const r = rangeOf(sf, node);
  return r.endLine - r.startLine;
}

// Function-like nodes whose span contains `anchorLine`, deepest (smallest span) first.
function enclosingFunctions(sf: ts.SourceFile, anchorLine: number): ts.Node[] {
  const hits: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const r = rangeOf(sf, node);
      if (r.startLine <= anchorLine && anchorLine <= r.endLine) hits.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  hits.sort((a, b) => spanLines(a, sf) - spanLines(b, sf));
  return hits;
}

// The nearest NAMED enclosing function for a changed range (the range's first line is the anchor).
// Climbs from the deepest enclosing function outward, returning the first that yields a name — so an
// anonymous arrow attributes to the named function around it. null ⇒ module-scope / all-anonymous.
export function enclosingFunctionOfRange(
  sf: ts.SourceFile,
  range: { startLine: number; endLine: number },
): { name: string; range: Range } | null {
  for (const node of enclosingFunctions(sf, range.startLine)) {
    const name = nameOfFunctionLike(node, sf);
    if (name) return { name, range: rangeOf(sf, node) };
  }
  return null;
}

function isDescendant(child: ts.Node, ancestor: ts.Node): boolean {
  let p: ts.Node | undefined = child.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

// Every NAMED function whose span overlaps any changed range, reduced to the leaf-most (a function is
// dropped if another named overlapping function is its descendant — keep the most specific). This is
// what lets one contiguous changed range that spans two sibling functions name BOTH, while a change
// inside an anonymous arrow names the function around it (the arrow is unnamed, so it never competes).
function namedFunctionsTouchingRanges(
  sf: ts.SourceFile,
  ranges: LineRange[],
): { name: string; range: Range; node: ts.Node }[] {
  const named: { name: string; range: Range; node: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const r = rangeOf(sf, node);
      const touches = ranges.some((rg) => r.startLine <= rg.endLine && rg.startLine <= r.endLine);
      if (touches) {
        const name = nameOfFunctionLike(node, sf);
        if (name) named.push({ name, range: r, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return named.filter((n) => !named.some((m) => m.node !== n.node && isDescendant(m.node, n.node)));
}

// The distinct changed function(s) across the changed CODE files (deduped by file + function name).
// A changed code region with no resolvable enclosing function yields a module-scope suspect (no name).
export function changedFunctions(changedFiles: ChangedFile[]): SuspectFunction[] {
  const out: SuspectFunction[] = [];
  const seen = new Set<string>();
  for (const f of changedFiles) {
    if (!isCodeFile(f.path)) continue;
    let sf: ts.SourceFile;
    try {
      sf = parse(f.path, f.currentText);
    } catch {
      continue; // unparseable → can't name a function; the file stays in the changed set elsewhere
    }
    const ranges = changedRanges(f.baselineText, f.currentText);
    if (ranges.length === 0) continue;
    const named = namedFunctionsTouchingRanges(sf, ranges);
    if (named.length === 0) {
      const key = `${f.path}::<module>`; // changed code but no enclosing function (module scope)
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ file: f.path });
      }
      continue;
    }
    for (const n of named) {
      const key = `${f.path}::${n.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: f.path, functionName: n.name, range: n.range });
    }
  }
  return out;
}

// Attribute a positive query-count delta to the changed function(s). Confidence reflects how cleanly
// the cause is named: a single changed function → high; several → medium suspects; nothing nameable →
// honest file/module-level at medium/low. Caller (delta-engine) has already verified determinism and
// queryDelta > 0 — without that premise this attribution is not trustworthy and is not produced.
export function attributeQueryDelta(
  changedFiles: ChangedFile[],
  queryDelta: number,
  baselineQ: number,
  currentQ: number,
): RunAttribution[] {
  const base = `query count rose ${baselineQ} → ${currentQ} (Δ${queryDelta}); the changed set is the only behavioral difference between the two trees`;
  const suspects = changedFunctions(changedFiles);
  const named = suspects.filter((s) => s.functionName);

  if (named.length === 1) {
    const s = named[0]!;
    return [
      {
        ruleId: RULE_N_PLUS_ONE,
        file: s.file,
        functionName: s.functionName,
        range: s.range,
        confidence: "high",
        evidence: `${base}; the single changed function is the cause`,
      },
    ];
  }
  if (named.length > 1) {
    return named.map((s) => ({
      ruleId: RULE_N_PLUS_ONE,
      file: s.file,
      functionName: s.functionName,
      range: s.range,
      confidence: "medium" as const,
      evidence: `${base}; one of ${named.length} changed functions`,
    }));
  }
  if (suspects.length > 0) {
    return suspects.map((s) => ({
      ruleId: RULE_N_PLUS_ONE,
      file: s.file,
      range: s.range,
      confidence: "medium" as const,
      evidence: `${base}; changed at module scope (no enclosing function resolved)`,
    }));
  }
  // Only non-code files changed — honest file-level note at low confidence.
  return changedFiles.map((f) => ({
    ruleId: RULE_N_PLUS_ONE,
    file: f.path,
    confidence: "low" as const,
    evidence: `${base}; no changed code function could be resolved`,
  }));
}
