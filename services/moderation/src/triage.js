/**
 * Pure triage helpers (no DB deps) — kept separate so they're unit-testable
 * without spinning up Postgres.
 */

const SEVERITY_BY_REASON = {
  safety: 5,
  child_safety: 5,
  csam: 5,
  violence: 5,
  scam: 4,
  fraud: 4,
  harassment: 4,
  hate: 4,
  nudity: 3,
  spam: 2,
  duplicate: 2,
  quality: 1,
  other: 1,
};

const SLA_HOURS_BY_SEVERITY = { 5: 2, 4: 4, 3: 24, 2: 48, 1: 72 };

export function computeSeverity(reasonCode, riskScore = 0) {
  const base = SEVERITY_BY_REASON[reasonCode] ?? 2;
  const risk = riskScore >= 80 ? 1 : 0;
  return Math.min(5, base + risk);
}

export function slaDueAt(severity, from = new Date()) {
  const hours = SLA_HOURS_BY_SEVERITY[severity] ?? 48;
  return new Date(from.getTime() + hours * 3600 * 1000);
}
