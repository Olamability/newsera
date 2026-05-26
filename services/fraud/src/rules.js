/**
 * Tiny declarative rule DSL evaluator.
 *
 * A rule definition looks like:
 *   {
 *     "subject": "user",                  // 'user' | 'listing' | 'device' | 'ip'
 *     "subjectPath": "user.id",           // dotted path into the event
 *     "when": { "all": [
 *        { "path": "event.kind",          "op": "eq", "value": "signup" },
 *        { "path": "context.signupsLast24hForIp", "op": "gte", "value": 5 }
 *     ]},
 *     "signal": { "code": "ip_signup_velocity", "score": 60 }
 *   }
 *
 * Supported ops: eq, neq, gt, gte, lt, lte, in, contains, regex, exists.
 * Combinators: { all: [...] }, { any: [...] }, { not: ... }.
 *
 * Keeping this small means rules can live in the `fraud_rules` DB table and be
 * edited by non-engineers without redeploying.
 */

export function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

const OPS = {
  eq:  (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt:  (a, b) => typeof a === 'number' && a >  b,
  gte: (a, b) => typeof a === 'number' && a >= b,
  lt:  (a, b) => typeof a === 'number' && a <  b,
  lte: (a, b) => typeof a === 'number' && a <= b,
  in:  (a, b) => Array.isArray(b) && b.includes(a),
  contains: (a, b) => typeof a === 'string' && a.includes(String(b)),
  regex:    (a, b) => typeof a === 'string' && new RegExp(b).test(a),
  exists:   (a) => a !== undefined && a !== null,
};

export function evalCondition(cond, ctx) {
  if (cond == null) return true;
  if (cond.all) return cond.all.every((c) => evalCondition(c, ctx));
  if (cond.any) return cond.any.some((c) => evalCondition(c, ctx));
  if (cond.not) return !evalCondition(cond.not, ctx);
  const op = OPS[cond.op];
  if (!op) throw new Error(`Unknown op: ${cond.op}`);
  return op(getPath(ctx, cond.path), cond.value);
}

/**
 * Evaluate one rule against an event/context. Returns a signal or null.
 */
export function evaluateRule(rule, event, context = {}) {
  const ctx = { event, context };
  if (!evalCondition(rule.definition.when, ctx)) return null;
  const subjectId = getPath(ctx, rule.definition.subjectPath);
  if (subjectId == null) return null;
  return {
    subjectType: rule.definition.subject,
    subjectId: String(subjectId),
    signalCode: rule.definition.signal.code,
    score: Number(rule.definition.signal.score ?? 25),
    source: 'rule',
    ruleId: rule.id,
    ruleVersion: rule.rule_version,
    evidence: rule.definition.signal.evidence ?? {},
  };
}

/**
 * Evaluate all enabled rules and return the produced signals.
 */
export function evaluateAll(rules, event, context = {}) {
  const out = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.mode === 'disabled') continue;
    try {
      const sig = evaluateRule(rule, event, context);
      if (sig) out.push({ ...sig, mode: rule.mode });
    } catch (e) {
      // Bad rule shouldn't kill the engine
      out.push({
        subjectType: 'system', subjectId: rule.id,
        signalCode: 'rule_error', score: 0, source: 'rule',
        ruleId: rule.id, ruleVersion: rule.rule_version,
        evidence: { error: String(e.message) },
        mode: 'shadow',
      });
    }
  }
  return out;
}
