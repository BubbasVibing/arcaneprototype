import { z } from "zod";
import { CategorySchema } from "./category";

// ArcaneConfig — the validation contract for `arcane.toml`.
// Authoritative human-facing shape: Product-Requirements §4.1. Cloud-validation rules: §12
// (unknown keys rejected via .strict(); `[cloud].endpoint` required iff mode = "self-host").
// The CLI parses `arcane.toml` with smol-toml and uploads it; the cloud validates against this.
//
// M1C/D1: `[score].weights`, `[analyzers].thresholds`, and `[gate].gate_on` speak the COARSE
// category vocabulary (quality/security/performance/maintainability, §4.1). That clash with the
// fine-grained `Dimension` enum (§5) is now reconciled — the bridge lives in `./category`, and
// these three fields are keyed/typed to `CategorySchema` (unknown categories are rejected).

const ProjectSchema = z
  .object({
    languages: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

const UiSchema = z
  .object({
    theme: z.enum(["auto", "dark", "light"]).optional(),
    density: z.enum(["summary", "full"]).optional(),
    accent: z.string().optional(),
  })
  .strict();

const ScoreConfigSchema = z
  .object({
    weights: z.record(CategorySchema, z.number()).optional(),
  })
  .strict();

const AnalyzersSchema = z
  .object({
    enabled: z.array(z.string()).optional(),
    disabled: z.array(z.string()).optional(),
    complexity: z.object({ max_cyclomatic: z.number().int().optional() }).strict().optional(),
    thresholds: z.record(CategorySchema, z.number()).optional(),
  })
  .strict();

const BaselineSchema = z.object({ ref: z.string().optional() }).strict();

const ExecutionSchema = z
  .object({
    enabled: z.boolean().optional(),
    require_permission: z.boolean().optional(),
    allow_in_ci: z.boolean().optional(),
    isolation: z.enum(["microvm", "container"]).optional(),
    timeout_ms: z.number().int().optional(),
    network: z.enum(["deny", "replay", "allow"]).optional(),
  })
  .strict();

const WorkloadSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    type: z.enum(["test", "server", "benchmark", "function"]),
    inputs: z.string().optional(),
    auto_grant: z.boolean().optional(),
    perf_budget: z.object({ p95_ms: z.number() }).strict().optional(),
  })
  .strict();

const AiSchema = z
  .object({
    enabled: z.boolean().optional(),
    judge_model: z.string().optional(),
    triage_model: z.string().optional(),
    daily_budget_usd: z.number().optional(),
    batch_in_ci: z.boolean().optional(),
  })
  .strict();

const GateSchema = z
  .object({
    gate_on: z.array(CategorySchema).optional(),
    fail_on: z.string().optional(),
  })
  .strict();

const CloudSchema = z
  .object({
    mode: z.enum(["cloud", "metadata-only", "self-host"]).optional(),
    endpoint: z.string().optional(),
    ephemeral: z.boolean().optional(),
    share_presence: z.boolean().optional(),
  })
  .strict();

export const ArcaneConfigSchema = z
  .object({
    project: ProjectSchema.optional(),
    ui: UiSchema.optional(),
    score: ScoreConfigSchema.optional(),
    analyzers: AnalyzersSchema.optional(),
    baseline: BaselineSchema.optional(),
    execution: ExecutionSchema.optional(),
    // `[[workload]]` in TOML → an array under the `workload` key.
    workload: z.array(WorkloadSchema).optional(),
    ai: AiSchema.optional(),
    gate: GateSchema.optional(),
    cloud: CloudSchema.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // §12: [cloud].endpoint is required iff mode = "self-host".
    if (cfg.cloud?.mode === "self-host" && !cfg.cloud.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloud", "endpoint"],
        message: 'cloud.endpoint is required when cloud.mode = "self-host"',
      });
    }
  });

export type ArcaneConfig = z.infer<typeof ArcaneConfigSchema>;
