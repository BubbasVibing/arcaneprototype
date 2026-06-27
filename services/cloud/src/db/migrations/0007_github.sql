-- GitHub App plane (Technical-Spec §13/§22) — pulled forward from M7 as an ADDITIVE second source.
-- The documented platform table mapping an org's external integration to its config. The GitHub
-- connector reads this (as arcane_cloud) to authorize an installation; a push is then mapped to a
-- project via the existing projects.repo_url column. Nothing here touches the CLI/ingest path.
--
-- SECURITY: unlike the other §22 platform tables (which sit RLS-disabled in this dev project),
-- integrations holds connector config (installation ids, and later tokens/metadata) that the anon
-- browser must NEVER read. So we ENABLE RLS with NO anon policy (hard-blocks the anon key) and grant
-- only the server's scoped arcane_cloud role a permissive policy — the result_events writer model
-- (0004/0006), but server-only (no browser read). Default anon/authenticated grants are revoked too.
CREATE TABLE integrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id),
  type        text NOT NULL,                 -- github_app|gitlab|slack
  config_json jsonb NOT NULL DEFAULT '{}',   -- type-specific, e.g. {app_id, installation_id, account_login}
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Resolve path: find the github_app integration by installation id, then the org's linked project.
CREATE INDEX integrations_org_type_idx ON integrations (org_id, type);

-- Keep connector config off the anon/authenticated keys entirely (defense in depth alongside RLS).
REVOKE ALL ON public.integrations FROM anon, authenticated;

-- The running server connects as arcane_cloud (not the owner, no RLS bypass). Grant the DML the
-- connector needs: SELECT (resolve an installation) + INSERT/UPDATE/DELETE (install/uninstall setup).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integrations TO arcane_cloud;

-- RLS on with a server-only policy: anon has no policy (blocked); arcane_cloud may read/write all rows.
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY integrations_cloud_all ON public.integrations
  FOR ALL TO arcane_cloud USING (true) WITH CHECK (true);
