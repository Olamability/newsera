import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { evaluateAll } from './rules.js';
import { bandFor, automatedAction } from './scoring.js';
import { DEFAULT_RULES } from '../rules/default.js';

const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (!connectionString) throw new Error('[fraud] DATABASE_URL required');
    pool = new Pool({ connectionString, max: Number(process.env.DB_POOL_MAX || 5) });
  }
  return pool;
}

/** Load rules from DB; falls back to bundled defaults if the table is empty. */
export async function loadRules() {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      `select id, description, rule_version, enabled, mode, definition from public.fraud_rules`,
    );
    return rows.length ? rows : DEFAULT_RULES;
  } finally {
    client.release();
  }
}

function inputsHash(event, context) {
  return createHash('sha256').update(JSON.stringify({ event, context })).digest('hex');
}

/**
 * Evaluate one event end-to-end:
 *   1. Run all enabled rules → produce candidate signals.
 *   2. Insert signals into `fraud_signals`.
 *   3. Aggregate by subject → update `risk_scores`.
 *   4. For rules in 'enforce' mode whose band warrants action, emit an
 *      auto-action descriptor for the caller to forward to the moderation
 *      service. (The fraud engine itself never writes business state directly;
 *      the moderation service is the only place that can.)
 */
export async function processEvent(event, context = {}) {
  const rules = await loadRules();
  const signals = evaluateAll(rules, event, context);
  if (signals.length === 0) return { signals: [], scores: [], autoActions: [] };

  const client = await getPool().connect();
  const scoreUpdates = new Map();
  try {
    await client.query('begin');
    for (const sig of signals) {
      await client.query(
        `insert into public.fraud_signals
           (subject_type, subject_id, signal_code, score, source, rule_id, rule_version, evidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          sig.subjectType,
          String(sig.subjectId),
          sig.signalCode,
          sig.score,
          sig.source,
          sig.ruleId ?? null,
          sig.ruleVersion ?? null,
          sig.evidence ?? {},
        ],
      );

      const key = `${sig.subjectType}:${sig.subjectId}`;
      const cur = scoreUpdates.get(key) ?? {
        subjectType: sig.subjectType,
        subjectId: sig.subjectId,
        score: 0,
        contributingRules: [],
        hasEnforce: false,
      };
      // Simple aggregation: sum-capped-at-100 of contributing scores.
      cur.score = Math.min(100, cur.score + Number(sig.score));
      cur.contributingRules.push({
        ruleId: sig.ruleId, ruleVersion: sig.ruleVersion,
        signalCode: sig.signalCode, score: sig.score,
      });
      if (sig.mode === 'enforce') cur.hasEnforce = true;
      scoreUpdates.set(key, cur);
    }

    const scores = [];
    const autoActions = [];
    for (const upd of scoreUpdates.values()) {
      const band = bandFor(upd.score);
      const hash = inputsHash(event, context);
      await client.query(
        `insert into public.risk_scores
           (subject_type, subject_id, score, band, inputs_hash, computed_at)
         values ($1,$2,$3,$4,$5, now())
         on conflict (subject_type, subject_id) do update
           set score = excluded.score,
               band  = excluded.band,
               inputs_hash = excluded.inputs_hash,
               computed_at = excluded.computed_at`,
        [upd.subjectType, String(upd.subjectId), upd.score, band, hash],
      );
      scores.push({ ...upd, band });

      // Auto-action is based on the AGGREGATED subject score, not any single
      // signal — so we never act before the full risk picture is computed.
      // Requires at least one contributing rule to be in 'enforce' mode.
      if (upd.hasEnforce) {
        const action = automatedAction(upd.subjectType, upd.score);
        if (action.action) {
          autoActions.push({
            requestId: randomUUID(),
            actionId: action.action,
            target: { id: upd.subjectId, type: upd.subjectType },
            payload: {
              ...action.payload,
              reasonCode: `fraud:${band}`,
              reasonText: `Automated action from aggregated risk score ${upd.score} (${band})`,
              metadata: { contributingRules: upd.contributingRules, score: upd.score, band },
            },
          });
        }
      }
    }

    await client.query('commit');
    return { signals, scores, autoActions };
  } catch (e) {
    try { await client.query('rollback'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
