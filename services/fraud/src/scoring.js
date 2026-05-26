/**
 * Convert a numeric score into a coarse risk band, and decide what to do.
 *
 *   low      → log only
 *   medium   → require verification on next sensitive action
 *   high     → auto-hide listing + open moderation case
 *   critical → auto-suspend pending review
 *
 * Thresholds are intentionally conservative; tune via env or per-rule overrides.
 */

export function bandFor(score) {
  if (score >= 90) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export function automatedAction(subjectType, score) {
  const band = bandFor(score);
  switch (band) {
    case 'critical':
      return subjectType === 'user'
        ? { action: 'user.suspend.temp', payload: { durationDays: 1, scope: 'full' } }
        : { action: 'listing.hide', payload: {} };
    case 'high':
      return subjectType === 'listing'
        ? { action: 'listing.hide', payload: {} }
        : { action: null, payload: null };
    default:
      return { action: null, payload: null };
  }
}
