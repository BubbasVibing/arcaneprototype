"use client";

import { useEffect, useRef, useState } from "react";
import {
  ResultEventSchema,
  applyResultEvent,
  emptyResultView,
  type ResultEvent,
  type ResultView,
} from "@arcane/shared";
import { supabase, supabaseConfigured } from "./supabase";

// Drives the dashboard's live view from the SAME ResultEvent stream the terminal gets (invariant 4),
// via Supabase Realtime postgres_changes on result_events. The seam (plan M1D):
//   1. SUBSCRIBE FIRST (buffer live rows) — closes the gap vs fetch-then-subscribe.
//   2. fetch the latest SESSION's latest frame (session-scoped boundary), replay by `seq`.
//   3. drain buffered live rows with seq > last applied; dedup by `seq`; then render.
// The browser renders SETTLED FRAMES; the analyzing-phase animation is terminal-only (per-frame flush).

export type StreamStatus = "unconfigured" | "connecting" | "live" | "empty" | "error";

interface Row {
  seq: number;
  session_id: string;
  ev: ResultEvent;
}

// One ordered, deduped, session-scoped reducer over result_events rows (shared by hydration + live).
class StreamReducer {
  activeSessionId: string | null = null;
  view: ResultView = emptyResultView();
  private readonly applied = new Set<number>();

  apply(row: Row): boolean {
    if (this.applied.has(row.seq)) return false; // dedup by seq (row may be in both backlog + live)
    // A new session's `analyzing` opens its first frame — switch to it and start fresh.
    if (row.ev.kind === "state" && row.ev.phase === "analyzing" && row.session_id !== this.activeSessionId) {
      this.activeSessionId = row.session_id;
      this.view = emptyResultView();
    }
    if (this.activeSessionId === null) this.activeSessionId = row.session_id; // first events of a session
    if (row.session_id !== this.activeSessionId) return false; // ignore other sessions (M1D: latest only)
    this.view = applyResultEvent(this.view, row.ev);
    this.applied.add(row.seq);
    return true;
  }

  hasData(): boolean {
    return this.view.scores.length > 0 || this.view.findings.length > 0;
  }
}

function toRow(raw: { seq: number | string; session_id: string; payload: unknown }): Row | null {
  const parsed = ResultEventSchema.safeParse(raw.payload);
  if (!parsed.success) return null; // never trust the wire — drop a malformed row
  return { seq: Number(raw.seq), session_id: raw.session_id, ev: parsed.data };
}

export function useResultStream(projectId: string): { view: ResultView; status: StreamStatus } {
  const [view, setView] = useState<ResultView>(emptyResultView);
  const [status, setStatus] = useState<StreamStatus>(
    supabaseConfigured ? "connecting" : "unconfigured",
  );

  useEffect(() => {
    if (!supabase) {
      setStatus("unconfigured");
      return;
    }
    const reducer = new StreamReducer();
    const buffered: Row[] = []; // live rows that arrive before hydration completes
    let hydrated = false;
    let cancelled = false;

    const render = (): void => {
      setView({ ...reducer.view });
      setStatus(reducer.hasData() ? "live" : "empty");
    };

    const channel = supabase
      .channel(`project:${projectId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "result_events",
          filter: `project_id=eq.${projectId}`,
        },
        (payload) => {
          const row = toRow(payload.new as { seq: number; session_id: string; payload: unknown });
          if (!row) return;
          if (!hydrated) {
            buffered.push(row); // hold until the backlog is replayed
            return;
          }
          if (reducer.apply(row)) render();
        },
      )
      .subscribe(async (state) => {
        if (state !== "SUBSCRIBED" || hydrated || cancelled) return;
        // Subscribed → fetch the latest session's latest frame (session-scoped boundary).
        const { data: latest } = await supabase!
          .from("result_events")
          .select("session_id")
          .eq("project_id", projectId)
          .order("seq", { ascending: false })
          .limit(1);
        if (cancelled) return;
        const sessionId = (latest as { session_id: string }[] | null)?.[0]?.session_id;
        if (sessionId) {
          const { data } = await supabase!
            .from("result_events")
            .select("seq, session_id, kind, payload")
            .eq("project_id", projectId)
            .eq("session_id", sessionId)
            .order("seq", { ascending: true });
          if (cancelled) return;
          const rows = (data ?? []) as { seq: number; session_id: string; kind: string; payload: unknown }[];
          // Boundary = the latest `analyzing` row's seq (its frame-minimum); replay from there.
          let boundary = 0;
          for (const r of rows) {
            const p = ResultEventSchema.safeParse(r.payload);
            if (p.success && p.data.kind === "state" && p.data.phase === "analyzing") boundary = r.seq;
          }
          for (const r of rows) {
            if (r.seq < boundary) continue;
            const row = toRow(r);
            if (row) reducer.apply(row);
          }
        }
        hydrated = true;
        for (const row of buffered) reducer.apply(row); // drain live rows buffered during hydration
        buffered.length = 0;
        render();
      });

    return () => {
      cancelled = true;
      void supabase!.removeChannel(channel);
    };
  }, [projectId]);

  return { view, status };
}
