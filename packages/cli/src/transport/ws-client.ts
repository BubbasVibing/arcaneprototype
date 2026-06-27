import {
  AckEventSchema,
  RELINK_CLOSE_CODE,
  ResultEventSchema,
  type AckEvent,
  type ChangeEvent,
  type ResultEvent,
} from "@arcane/shared";
import { WebSocket } from "ws";

// The token-gated WS ingest client (M1B). It streams ChangeEvents to /ingest and demuxes the two
// kinds of server → CLI frame: an AckEvent (has `ackSeq`, no `kind`) drives the journal; a
// ResultEvent (has `kind`) drives the TUI. The token is carried in the connect URL (cloudWsIngest).
//
// B2: auto-reconnects with backoff, and on every (re)open calls `onOpen` so the caller can replay
// the unacked journal tail (§3A.3). There is NO outbound buffer — the journal is the single source
// of retention, so a send while offline is dropped on the wire and replayed on reconnect.

export type ConnState = "connecting" | "open" | "closed" | "error";

export interface WsClientOptions {
  // A string, or an async provider resolved on every (re)connect. The provider lets `watch` re-read
  // git context and fold it into the /ingest URL each connect (§3A.5 refresh) — no new wire frame.
  url: string | (() => Promise<string>);
  onResult: (ev: ResultEvent) => void;
  onAck?: (ack: AckEvent) => void;
  onOpen?: () => void; // (re)connected — replay the unacked journal tail here
  onState?: (state: ConnState, detail?: string) => void;
  // Server sent the relink close code (§3A.4): the caller re-links then calls connect() again. We do
  // NOT auto-reconnect here — replaying into an unknown project would just loop.
  onRelinkRequired?: () => void;
}

const MAX_BACKOFF_MS = 5_000;

export class WsClient {
  private ws: WebSocket | undefined;
  private open = false;
  private closedByUser = false;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    this.closedByUser = false;
    void this.openSocket();
  }

  private async openSocket(): Promise<void> {
    this.opts.onState?.("connecting");
    let url: string;
    try {
      url = typeof this.opts.url === "string" ? this.opts.url : await this.opts.url();
    } catch (err) {
      // URL provider failed (e.g. a transient git read) — treat like a connect error and back off.
      this.opts.onState?.("error", (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    if (this.closedByUser) return; // closed while resolving the URL
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.open = true;
      this.reconnects = 0;
      this.opts.onState?.("open");
      this.opts.onOpen?.(); // caller replays unacked events from the journal
    });

    ws.on("message", (data) => {
      let payload: unknown;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      // Demux by shape: AckEvent carries `ackSeq` and no `kind`; ResultEvent always has `kind`.
      if (payload && typeof payload === "object" && "ackSeq" in payload) {
        const ack = AckEventSchema.safeParse(payload);
        if (ack.success) this.opts.onAck?.(ack.data);
        return;
      }
      const parsed = ResultEventSchema.safeParse(payload);
      if (parsed.success) this.opts.onResult(parsed.data);
    });

    ws.on("close", (code: number) => {
      this.open = false;
      this.opts.onState?.("closed");
      if (code === RELINK_CLOSE_CODE) {
        // Project unknown server-side: don't reconnect (it would loop). Hand off to the caller's
        // relink routine, which re-links and then calls connect() again (§3A.4 self-heal).
        this.opts.onRelinkRequired?.();
        return;
      }
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.opts.onState?.("error", err.message);
      // a 'close' event follows and drives the reconnect
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.reconnects);
    this.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closedByUser) void this.openSocket();
    }, delay);
  }

  // Transmit if connected; otherwise drop — the journal retains it and `onOpen` replays it.
  send(event: ChangeEvent): void {
    if (this.open && this.ws) this.ws.send(JSON.stringify(event));
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
  }
}
