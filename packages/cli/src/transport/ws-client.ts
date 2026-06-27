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
// B1 buffers outbound events until the socket opens, then flushes in order; auto-reconnect, journal
// replay, and resyncFrom handling are B2.

export type ConnState = "connecting" | "open" | "closed" | "error";

export interface WsClientOptions {
  url: string;
  onResult: (ev: ResultEvent) => void;
  onAck?: (ack: AckEvent) => void;
  onState?: (state: ConnState, detail?: string) => void;
}

export class WsClient {
  private ws: WebSocket | undefined;
  private readonly queue: string[] = []; // outbound messages buffered until 'open'
  private open = false;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    this.opts.onState?.("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.open = true;
      for (const msg of this.queue) ws.send(msg);
      this.queue.length = 0;
      this.opts.onState?.("open");
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
    });

    ws.on("error", (err: Error) => {
      this.opts.onState?.("error", err.message);
    });
  }

  send(event: ChangeEvent): void {
    const msg = JSON.stringify(event);
    if (this.open && this.ws) this.ws.send(msg);
    else this.queue.push(msg); // flushed on open (no resync/journal in M1A)
  }

  close(): void {
    this.ws?.close();
  }
}
