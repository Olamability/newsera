import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRule, evaluateAll, evalCondition, getPath } from '../src/rules.js';
import { bandFor, automatedAction } from '../src/scoring.js';
import { DEFAULT_RULES } from '../rules/default.js';

test('getPath traverses dotted paths safely', () => {
  assert.equal(getPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
  assert.equal(getPath(null, 'a.b'), null);
  assert.equal(getPath({}, 'a.b'), undefined);
});

test('evalCondition supports all/any/not + ops', () => {
  const ctx = { event: { kind: 'signup', age: 1 }, context: { trusted: false } };
  assert.equal(evalCondition({ path: 'event.kind', op: 'eq', value: 'signup' }, ctx), true);
  assert.equal(evalCondition({ any: [
    { path: 'event.age', op: 'gt', value: 99 },
    { path: 'context.trusted', op: 'eq', value: false },
  ]}, ctx), true);
  assert.equal(evalCondition({ not: { path: 'event.kind', op: 'eq', value: 'signup' } }, ctx), false);
});

test('ip_signup_velocity rule fires on threshold breach', () => {
  const rule = DEFAULT_RULES.find(r => r.id === 'ip_signup_velocity');
  const sig = evaluateRule(rule, { kind: 'signup', ip: '1.2.3.4' }, { signupsLast24hForIp: 7 });
  assert.ok(sig);
  assert.equal(sig.subjectType, 'ip');
  assert.equal(sig.subjectId, '1.2.3.4');
  assert.equal(sig.signalCode, 'ip_signup_velocity');
});

test('ip_signup_velocity rule does not fire below threshold', () => {
  const rule = DEFAULT_RULES.find(r => r.id === 'ip_signup_velocity');
  const sig = evaluateRule(rule, { kind: 'signup', ip: '1.2.3.4' }, { signupsLast24hForIp: 1 });
  assert.equal(sig, null);
});

test('evaluateAll skips disabled and broken rules without throwing', () => {
  const rules = [
    { id: 'off', enabled: false, mode: 'enforce', definition: {} },
    { id: 'bad', enabled: true,  mode: 'enforce',
      definition: { subject: 'user', subjectPath: 'event.userId',
                    when: { path: 'event.kind', op: 'bogus', value: 1 },
                    signal: { code: 'x', score: 1 } } },
  ];
  const out = evaluateAll(rules, { kind: 'signup', userId: 'u1' }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].signalCode, 'rule_error');
});

test('bandFor thresholds', () => {
  assert.equal(bandFor(10), 'low');
  assert.equal(bandFor(45), 'medium');
  assert.equal(bandFor(75), 'high');
  assert.equal(bandFor(95), 'critical');
});

test('automatedAction returns hide for high-risk listings', () => {
  const a = automatedAction('listing', 80);
  assert.equal(a.action, 'listing.hide');
});

test('automatedAction returns suspend for critical users', () => {
  const a = automatedAction('user', 95);
  assert.equal(a.action, 'user.suspend.temp');
  assert.equal(a.payload.scope, 'full');
});

test('automatedAction returns null at low band', () => {
  const a = automatedAction('user', 20);
  assert.equal(a.action, null);
});
