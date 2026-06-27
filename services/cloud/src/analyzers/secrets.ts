import type { Finding, Severity } from "@arcane/shared";
import { findingId, type Analyzer, type AnalyzerInput } from "./types";

// Secrets analyzer (plan M1C/D4, dimension `secrets`). A curated regex ruleset patterned on
// gitleaks' well-known defaults — dependency-light and deterministic for M1C. A full secrets engine
// (gitleaks/secretlint) is the M2 upgrade. Findings never echo the secret value, only a label.

interface Rule {
  id: string;
  re: RegExp;
  severity: Severity;
  label: string;
}

const RULES: Rule[] = [
  { id: "secrets/aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/, severity: "critical", label: "AWS access key id" },
  { id: "secrets/private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, severity: "critical", label: "private key block" },
  { id: "secrets/github-token", re: /\bgh[posru]_[0-9A-Za-z]{36}\b/, severity: "critical", label: "GitHub token" },
  { id: "secrets/stripe-key", re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/, severity: "critical", label: "Stripe secret key" },
  { id: "secrets/slack-token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, severity: "high", label: "Slack token" },
  { id: "secrets/google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "high", label: "Google API key" },
  {
    id: "secrets/generic-assignment",
    re: /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    severity: "high",
    label: "hardcoded credential",
  },
];

// Skip obvious binaries/large assets (M1B materializes inline text only anyway).
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mov|mp3|wasm|lock)$/i;

export function makeSecretsAnalyzer(): Analyzer {
  return {
    name: "secrets",
    handles: (path) => !BINARY_EXT.test(path),
    analyze({ path, content }: AnalyzerInput): Finding[] {
      const findings: Finding[] = [];
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const rule of RULES) {
          const m = rule.re.exec(line);
          if (!m) continue;
          const matched = m[0] ?? "";
          const col = (m.index ?? 0) + 1;
          findings.push({
            id: findingId(rule.id, path, { startLine: i + 1, startCol: col, endLine: i + 1, endCol: col + matched.length }),
            dimension: "secrets",
            severity: rule.severity,
            ruleId: rule.id,
            message: `possible hardcoded secret: ${rule.label}`,
            file: path,
            range: { startLine: i + 1, startCol: col, endLine: i + 1, endCol: col + matched.length },
            fixable: false,
          });
        }
      }
      return findings;
    },
  };
}

export const secretsAnalyzer = makeSecretsAnalyzer();
