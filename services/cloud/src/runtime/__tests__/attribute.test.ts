import { describe, expect, test } from "bun:test";
import { attributeQueryDelta, changedFunctions, enclosingFunctionOfRange } from "../attribute";
import { parse } from "../../analyzers/ts-ast";
import { changedRanges, diffManifests } from "../worktrees";
import type { Manifest } from "../../session-store";

// M3C PURE attribution — no Docker, always runs. Proves the causal changed-set → enclosing-function
// mapping that the N+1 gate's "attributed to the changed function" claim rests on.

// A function with one query; current adds a loop of queries (the canonical N+1).
const USERS_BASE = `function getUser(id) {
  return db.query("SELECT * FROM users WHERE id = $1", [id]);
}
`;
const USERS_CUR = `function getUser(id) {
  const out = [];
  for (let i = 0; i < id.length; i++) {
    out.push(db.query("SELECT * FROM users WHERE id = $1", [id[i]]));
  }
  return out;
}
`;

// The query lives in an anonymous arrow; attribution must CLIMB to the named function around it.
const ORDERS_BASE = `function loadOrders(ids) {
  const results = [];
  return results;
}
`;
const ORDERS_CUR = `function loadOrders(ids) {
  const results = [];
  ids.forEach((id) => {
    results.push(db.query("SELECT * FROM orders WHERE id = $1", [id]));
  });
  return results;
}
`;

// A change at module scope (no enclosing function).
const MODULE_BASE = `const config = { a: 1 };
`;
const MODULE_CUR = `const config = { a: 1 };
const extra = db.query("SELECT 1");
`;

describe("changedRanges (worktrees)", () => {
  test("added lines surface as current-coordinate ranges", () => {
    const ranges = changedRanges(USERS_BASE, USERS_CUR);
    expect(ranges.length).toBeGreaterThan(0);
    // the first added line is line 2 (`const out = [];`)
    expect(ranges[0]!.startLine).toBe(2);
  });

  test("a brand-new file is wholly changed", () => {
    const ranges = changedRanges(undefined, "a\nb\nc\n");
    expect(ranges).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  test("identical text yields no ranges", () => {
    expect(changedRanges(USERS_CUR, USERS_CUR)).toEqual([]);
  });
});

describe("diffManifests (worktrees)", () => {
  test("detects added, removed, and hash-changed paths", () => {
    const base: Manifest = new Map([
      ["a.js", "h1"],
      ["b.js", "h2"],
    ]);
    const cur: Manifest = new Map([
      ["a.js", "h1"], // unchanged
      ["b.js", "h3"], // changed
      ["c.js", "h4"], // added
    ]);
    expect(diffManifests(base, cur)).toEqual(["b.js", "c.js"]);
  });

  test("detects a removed path", () => {
    const base: Manifest = new Map([
      ["a.js", "h1"],
      ["b.js", "h2"],
    ]);
    const cur: Manifest = new Map([["a.js", "h1"]]);
    expect(diffManifests(base, cur)).toEqual(["b.js"]);
  });
});

describe("enclosingFunctionOfRange", () => {
  test("names the directly enclosing function", () => {
    const sf = parse("users.js", USERS_CUR);
    const fn = enclosingFunctionOfRange(sf, { startLine: 3, endLine: 5 });
    expect(fn?.name).toBe("getUser");
  });

  test("climbs from an anonymous arrow to the nearest named function", () => {
    const sf = parse("orders.js", ORDERS_CUR);
    const fn = enclosingFunctionOfRange(sf, { startLine: 4, endLine: 4 }); // inside the arrow
    expect(fn?.name).toBe("loadOrders");
  });

  test("module-scope change resolves to no function", () => {
    const sf = parse("mod.js", MODULE_CUR);
    const fn = enclosingFunctionOfRange(sf, { startLine: 2, endLine: 2 });
    expect(fn).toBeNull();
  });
});

describe("attributeQueryDelta", () => {
  test("single changed function → high confidence, named", () => {
    const out = attributeQueryDelta(
      [{ path: "users.js", baselineText: USERS_BASE, currentText: USERS_CUR }],
      4,
      1,
      5,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.functionName).toBe("getUser");
    expect(out[0]!.confidence).toBe("high");
    expect(out[0]!.ruleId).toBe("runtime/n-plus-one");
    expect(out[0]!.range?.startLine).toBe(1);
  });

  test("anonymous-arrow N+1 attributes to the enclosing named function", () => {
    const out = attributeQueryDelta(
      [{ path: "orders.js", baselineText: ORDERS_BASE, currentText: ORDERS_CUR }],
      3,
      0,
      3,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.functionName).toBe("loadOrders");
    expect(out[0]!.confidence).toBe("high");
  });

  test("multiple changed functions → medium suspects", () => {
    const baseTwo = `function a() { return db.query("SELECT 1"); }
function b() { return 2; }
`;
    const curTwo = `function a() { for (const x of xs) db.query("SELECT 1"); return 0; }
function b() { for (const y of ys) db.query("SELECT 2"); return 2; }
`;
    const out = attributeQueryDelta(
      [{ path: "two.js", baselineText: baseTwo, currentText: curTwo }],
      6,
      0,
      6,
    );
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((a) => a.confidence === "medium")).toBe(true);
    expect(out.map((a) => a.functionName).sort()).toEqual(["a", "b"]);
  });

  test("module-scope change → medium file-level (no function named)", () => {
    const out = attributeQueryDelta(
      [{ path: "mod.js", baselineText: MODULE_BASE, currentText: MODULE_CUR }],
      1,
      0,
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.functionName).toBeUndefined();
    expect(out[0]!.confidence).toBe("medium");
  });
});
