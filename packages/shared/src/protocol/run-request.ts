import { z } from "zod";
import { ManifestFileSchema } from "./link";

// Technical-Spec §19.1 / §19A — the `arcane run` trigger contract (CLI → cloud, POST /run). M3D opens
// the FIRST non-test path to executing code, so this schema is a load-bearing safety surface.
//
// SAFETY (the deepest M3D invariant): the request carries NO command / network / timeout / image. Every
// execution parameter is DERIVED SERVER-SIDE from the cloud-held ArcaneConfig (the declared
// `[[workload]]`). A request can only NAME a workload, never supply the argv — so "Arcane never runs a
// command the user didn't write into arcane.toml" holds BY CONSTRUCTION (no RCE-with-a-prompt). The
// cloud authoritatively re-derives the command from config; this schema deliberately has no field for it.

// The per-run human consent signal (§19.1 gate 3). null ⇒ no explicit grant in the request (the cloud
// then accepts only via the workload's `auto_grant` or CI's `allow_in_ci`). The CLI sets a non-null
// value ONLY after a real prompt or a stored grant — the cloud cannot verify a keypress, so it requires
// this signal to be present (see §3 of the M3D plan, the trust boundary).
export const RunConsentSchema = z.enum(["once", "session", "always"]);
export type RunConsent = z.infer<typeof RunConsentSchema>;

export const RunRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    workloadName: z.string(), // names a declared [[workload]]; the cloud derives the argv from config
    baselineRef: z.string(), // label only (e.g. "origin/main")
    currentRef: z.string(), // label only (e.g. "working")
    baselineFiles: z.array(ManifestFileSchema), // the baseline tree (CLI-shipped, like `link`)
    currentFiles: z.array(ManifestFileSchema), // the current tree
    consent: RunConsentSchema.nullable(), // explicit per-run grant, or null
    ci: z.boolean(), // headless/CI invocation (no TTY) — gate C then needs allow_in_ci
  })
  .strict(); // reject unknown keys — a `command`/`network`/`timeout` in the body is an ERROR, not ignored
export type RunRequest = z.infer<typeof RunRequestSchema>;

// Cloud → CLI on accept (202). The run is enqueued (cold path); results stream later as ResultEvents
// (state phases + the final kind:'run' RunReport) on the project's channel. Refusals are HTTP 4xx +
// a plain-text reason, NOT this shape.
export const RunAcceptSchema = z.object({
  runId: z.string().uuid(),
  runSessionId: z.string().uuid(),
});
export type RunAccept = z.infer<typeof RunAcceptSchema>;
