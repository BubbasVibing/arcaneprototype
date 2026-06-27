import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthTokenResponseSchema } from "@arcane/shared";

// STUB auth (Build Guide §18 / §23): the CLI token lives in `~/.arcane` (a FILE, chmod 600) — no
// native keychain dep, which keeps `npm i -g` painless. `arcane login` fetches the dev token from
// the gateway and writes it here; real OAuth device-flow login (§23) is a later milestone. (Distinct
// from the repo-local `.arcane/` DIRECTORY that holds per-project link + journal state.)

const TOKEN_PATH = process.env.ARCANE_TOKEN_PATH ?? join(homedir(), ".arcane");

export async function login(httpBase: string): Promise<void> {
  const res = await fetch(`${httpBase}/auth/token`, { method: "POST" });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = AuthTokenResponseSchema.parse(await res.json());
  writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
}

export function readToken(): string | undefined {
  if (!existsSync(TOKEN_PATH)) return undefined;
  const token = readFileSync(TOKEN_PATH, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

export function logout(): void {
  if (existsSync(TOKEN_PATH)) rmSync(TOKEN_PATH);
}
