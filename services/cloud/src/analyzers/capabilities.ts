// Capability probing for external-CLI analyzers (M2B graceful degrade). External tools (semgrep,
// gitleaks, osv-scanner) are baked into the engine image, NOT npm deps — so they may be absent in a
// dev/CI box. We probe each ONCE (memoized for the process: the image is static, so one probe per
// boot is correct) by spawning `<bin> --version`; absence is a clean skip, never a crash.
//
// Honesty (invariant 8): an enabled-but-unavailable tool is recorded as `available:false` so a clean
// dimension that simply wasn't analyzed is distinguishable from one that was analyzed and found clean.
// There is no `arcane doctor` command (§4.2) and no capability ResultEvent kind (§3B.2), so the
// surface is a loud server log + this in-process map — a user-facing report needs a doc change first.

export interface Capability {
  name: string;
  bin: string;
  available: boolean;
  version?: string;
}

const cache = new Map<string, Capability>();

export async function probe(bin: string, versionArgs: string[] = ["--version"]): Promise<Capability> {
  const cached = cache.get(bin);
  if (cached) return cached;

  let available = false;
  let version: string | undefined;
  try {
    const proc = Bun.spawn([bin, ...versionArgs], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code === 0) {
      available = true;
      version = (await new Response(proc.stdout).text()).trim().split("\n")[0] || undefined;
    }
  } catch {
    available = false; // ENOENT (bin not on PATH) or spawn failure → unavailable
  }

  const cap: Capability = { name: bin, bin, available, version };
  cache.set(bin, cap);
  if (!available) {
    console.warn(`⚠️  analyzer tool '${bin}' not found on this engine — its findings will be SKIPPED`);
  }
  return cap;
}

// The probed tools so far (process-lifetime). Persisted onto analysis jobs / logged for legibility.
export function capabilityMap(): ReadonlyMap<string, Capability> {
  return cache;
}

// Test-only: forget probed results so a test can re-probe.
export function resetCapabilities(): void {
  cache.clear();
}
