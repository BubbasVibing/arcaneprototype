-- Fixed dev identity (plan M1C / D2b). The FK anchor for persisted scores/findings while auth is a
-- stub token (auth.ts). UUIDs match services/cloud/src/db/constants.ts. Idempotent.
INSERT INTO orgs (id, name, slug)
  VALUES ('00000000-0000-0000-0000-0000000000a1', 'Arcane Dev Org', 'arcane-dev')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, email, name)
  VALUES ('00000000-0000-0000-0000-0000000000b1', 'dev@arcane.local', 'Arcane Dev')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO memberships (org_id, user_id, role)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'owner')
  ON CONFLICT (org_id, user_id) DO NOTHING;

INSERT INTO cli_tokens (id, user_id, name, token_hash)
  VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
          'dev-stub', 'dev-stub-token')
  ON CONFLICT (id) DO NOTHING;
