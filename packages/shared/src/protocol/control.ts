// Application WebSocket close codes (CLI ↔ cloud), in the app-defined 4000–4999 range. These carry
// out-of-band control signals WITHOUT adding a new message frame to the wire — keeping the protocol
// surface minimal (the same principle as carrying git context as connection metadata, §3A.5).

// Server → CLI on `/ingest`: the project is unknown (the cloud restarted and lost its in-memory
// baseline, §3A.4). The CLI auto-relinks and reconnects rather than looping its replay forever.
export const RELINK_CLOSE_CODE = 4404;
