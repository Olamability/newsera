// Shared date / time formatting helpers for the admin panel.
//
// Centralised here so every panel renders timestamps consistently
// ("Updated 3m ago" instead of one panel rendering "3 minutes ago" and
// another rendering "180s ago"). UI.jsx re-exports these so existing
// imports (`from '../UI'`) continue to work unchanged.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format an absolute timestamp using the browser locale.
 *
 * Returns `'—'` for nullish input so admin tables never render an
 * empty cell.
 */
export function formatDateTime(input) {
  if (input === null || input === undefined || input === '') return '—';
  try {
    return new Date(input).toLocaleString();
  } catch {
    return String(input);
  }
}

/**
 * Format a timestamp as a short relative string ("3m ago", "2h ago").
 *
 * Mirrors the cadence used by the mobile-app `relativeTime` helper so an
 * operator looking at the admin dashboard and a user looking at the feed
 * see comparable "freshness" labels.
 *
 * Clock skew safety: timestamps slightly in the future (server now() vs.
 * browser clock drift) are clamped to "just now".
 */
export function formatRelative(input) {
  if (input === null || input === undefined || input === '') return '—';
  const ts = new Date(input).getTime();
  if (!Number.isFinite(ts)) return String(input);

  const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < MINUTE) return `${diffSec}s ago`;
  if (diffSec < HOUR) return `${Math.round(diffSec / MINUTE)}m ago`;
  if (diffSec < DAY) return `${Math.round(diffSec / HOUR)}h ago`;
  return `${Math.round(diffSec / DAY)}d ago`;
}
