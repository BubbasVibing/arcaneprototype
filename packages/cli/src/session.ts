import { randomUUID } from "node:crypto";

// One watch session's identity. sessionId is a real UUID now that the collector exists
// (tightened in @arcane/shared — M1A decision #1). projectId / parentSnapshotId stay
// placeholders until M1B brings real `arcane link` + shadow-worktree snapshots.

export interface Session {
  sessionId: string;
  projectId: string;
  parentSnapshotId: string;
}

export function makeSession(): Session {
  return {
    sessionId: randomUUID(),
    projectId: "project-0",
    parentSnapshotId: "snapshot-0",
  };
}
