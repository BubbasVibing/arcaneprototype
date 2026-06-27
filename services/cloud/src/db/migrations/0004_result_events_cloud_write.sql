-- Arcane M1D (plan D1) — RLS on result_events (0003) is enforced for the CLOUD's role too. The cloud
-- connects as `arcane_cloud`, which is NOT a superuser and does NOT bypass RLS (unlike postgres /
-- service_role), so enabling RLS blocked its own fan-out INSERTs. Grant the trusted server writer an
-- explicit INSERT policy. anon stays SELECT-only (0003); least-privilege — scoped to result_events.
DROP POLICY IF EXISTS result_events_cloud_write ON public.result_events;
CREATE POLICY result_events_cloud_write ON public.result_events
  FOR INSERT TO arcane_cloud WITH CHECK (true);
