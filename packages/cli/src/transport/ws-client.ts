import {
  AckEventSchema,
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
  url: string;
  onResult: (ev: ResultEvent) => void;
  onAck?: (ack: AckEvent) => void;
  onOpen?: () => void; // (re)connected — replay the unacked journal tail here
  onState?: (state: ConnState, detail?: string) => void;
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
    this.openSocket();
  }

  private openSocket(): void {
    this.opts.onState?.("connecting");
    const ws = new WebSocket(this.opts.url);
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

    ws.on("close", () => {
      this.open = false;
      this.opts.onState?.("closed");
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
      if (!this.closedByUser) this.openSocket();
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
