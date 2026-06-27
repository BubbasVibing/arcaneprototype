-- M3D — result_events has RLS (0003) with an anon SELECT policy (browser) + an arcane_cloud INSERT
-- policy (0004), but no arcane_cloud SELECT policy. The cloud writes result_events but could not read
-- them back (arcane_cloud is not a superuser and does not bypass RLS). M3D's run worker + verification
-- (and future hydration/replay) need the writer to read its own rows. Grant arcane_cloud SELECT.
CREATE POLICY result_events_cloud_read ON public.result_events
  FOR SELECT TO arcane_cloud USING (true);
