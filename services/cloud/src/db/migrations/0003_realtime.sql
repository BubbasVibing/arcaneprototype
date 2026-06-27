-- Arcane M1D (plan D1.2) — wire Supabase Realtime for the web mirror.
-- The cloud writes result_events via the `postgres` role (bypasses RLS); the browser reads via the
-- anon key (RLS-enforced). One batched INSERT per analyzed frame → WAL → Realtime postgres_changes →
-- the dashboard subscribed to channel project:{id}. No realtime client on the server.

-- A monotonic ordinal for ORDERED hydration. A per-frame batched INSERT shares one now(), so
-- created_at cannot order rows within a frame; `seq` is assigned in INSERT row order (the fan-out
-- writes `analyzing` first, so each frame's analyzing row holds the frame-minimum seq).
ALTER TABLE public.result_events ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

-- Publish result_events INSERTs to Realtime (postgres_changes).
ALTER PUBLICATION supabase_realtime ADD TABLE public.result_events;

-- The browser reads with the anon key under RLS. M1D dev: public-read (single dev project, no real
-- auth); M8 tightens to org/project membership (§22). The cloud's postgres-role writes bypass RLS,
-- so enabling RLS here does NOT block ingestion — it only gates the anon reader.
ALTER TABLE public.result_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.result_events TO anon;
DROP POLICY IF EXISTS result_events_anon_read ON public.result_events;
CREATE POLICY result_events_anon_read ON public.result_events FOR SELECT TO anon USING (true);
