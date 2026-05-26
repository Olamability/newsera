import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSeverity, slaDueAt } from '../src/triage.js';
import { ACTIONS, actionById } from '../src/actions.js';
import { requirePermission } from '../src/permissions.js';

test('computeSeverity uses reason mapping', () => {
  assert.equal(computeSeverity('spam'), 2);
  assert.equal(computeSeverity('scam'), 4);
  assert.equal(computeSeverity('safety'), 5);
  assert.equal(computeSeverity('unknown_reason'), 2);
});

test('computeSeverity is bumped by high target risk', () => {
  assert.equal(computeSeverity('spam', 90), 3);
  assert.equal(computeSeverity('safety', 90), 5); // capped at 5
});

test('slaDueAt is tighter for higher severity', () => {
  const from = new Date('2025-01-01T00:00:00Z');
  const high = slaDueAt(5, from).getTime() - from.getTime();
  const low  = slaDueAt(1, from).getTime() - from.getTime();
  assert.ok(high < low, 'higher severity should have shorter SLA');
});

test('action catalog has unique permission entries', () => {
  const ids = Object.values(ACTIONS).map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'action ids must be unique');
  for (const a of Object.values(ACTIONS)) {
    assert.ok(a.permission, `action ${a.id} must declare a permission`);
    assert.ok(a.targetType, `action ${a.id} must declare a targetType`);
  }
});

test('requirePermission throws when permission missing', () => {
  const perms = new Set(['reports.read']);
  assert.throws(
    () => requirePermission('listing.hide', perms),
    /Permission denied/,
  );
});

test('requirePermission passes when permission present', () => {
  const action = actionById('listing.hide');
  const perms = new Set([action.permission]);
  const result = requirePermission('listing.hide', perms);
  assert.equal(result.id, 'listing.hide');
});
