// Fixed dev identity (plan M1C / D2b). Auth is still a stub token (see auth.ts), so persisted
// scores/findings need a seeded FK anchor: the `0002_dev_seed.sql` migration inserts these exact
// rows (a dev user + org + membership). `ensureProject` / `ensureSession` reference them so the §7
// FK chain (projects → orgs, sessions → users) resolves without real auth. Replaced when the §23
// device-link flow lands.
export const DEV_ORG_ID = "00000000-0000-0000-0000-0000000000a1";
export const DEV_USER_ID = "00000000-0000-0000-0000-0000000000b1";
