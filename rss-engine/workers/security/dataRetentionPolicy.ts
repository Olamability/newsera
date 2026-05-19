/**
 * Phase G — Data retention policy.
 *
 * Defines per-table retention windows and detects violations (rows older
 * than the policy allows). Pure compute; the host supplies the row-age
 * inventory and the policy.
 */

export interface RetentionRule {
  table: string;
  maxAgeMs: number;
  /** PII level — informational; affects severity weighting. */
  piiLevel: 'none' | 'low' | 'high';
  /** True if this table requires a hard delete (vs anonymise). */
  hardDelete: boolean;
}

export interface TableInventory {
  table: string;
  /** Count of rows older than each rule's maxAgeMs. */
  rowsExceedingAge: number;
  oldestRowAgeMs: number;
  totalRows: number;
}

export interface RetentionViolation {
  table: string;
  rule: RetentionRule;
  oldestRowAgeMs: number;
  rowsExceedingAge: number;
  severity: 'info' | 'warn' | 'severe';
}

export function evaluateRetention(
  rules: RetentionRule[],
  inventory: TableInventory[],
): RetentionViolation[] {
  const inventoryByTable = new Map(inventory.map((i) => [i.table, i]));
  const out: RetentionViolation[] = [];
  for (const rule of rules) {
    const inv = inventoryByTable.get(rule.table);
    if (!inv) continue;
    if (inv.oldestRowAgeMs <= rule.maxAgeMs) continue;
    let severity: RetentionViolation['severity'] = 'info';
    if (rule.piiLevel === 'high') severity = 'severe';
    else if (rule.piiLevel === 'low') severity = 'warn';
    if (inv.rowsExceedingAge > inv.totalRows * 0.5) {
      severity = 'severe';
    }
    out.push({
      table: rule.table,
      rule,
      oldestRowAgeMs: inv.oldestRowAgeMs,
      rowsExceedingAge: inv.rowsExceedingAge,
      severity,
    });
  }
  return out;
}

export const DEFAULT_RETENTION_RULES: RetentionRule[] = [
  { table: 'admin_audit_log', maxAgeMs: 365 * 86_400_000, piiLevel: 'low', hardDelete: false },
  { table: 'notification_log', maxAgeMs: 90 * 86_400_000, piiLevel: 'low', hardDelete: false },
  { table: 'analytics_events', maxAgeMs: 180 * 86_400_000, piiLevel: 'low', hardDelete: false },
  { table: 'session_tokens', maxAgeMs: 30 * 86_400_000, piiLevel: 'high', hardDelete: true },
  { table: 'pii_scratch', maxAgeMs: 7 * 86_400_000, piiLevel: 'high', hardDelete: true },
  { table: 'job_dead_letter', maxAgeMs: 60 * 86_400_000, piiLevel: 'none', hardDelete: false },
];
