import { ResultEventSchema, type ChangeEvent, type ResultEvent } from "@arcane/shared";
import { WebSocket } from "ws";

// Authenticated WSS client is M1B; in M1A this is a plain ws client that streams ChangeEvents
// and surfaces validated ResultEvents — the same pattern as the Session-0 `sendtest` round-trip.
// No journal / replay / resync-on-gap here (those are M1B): events are only buffered until the
// socket opens, then flushed in order.

export type ConnState = "connecting" | "open" | "closed" | "error";

export interface WsClientOptions {
  url: string;
  onResult: (ev: ResultEvent) => void;
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
