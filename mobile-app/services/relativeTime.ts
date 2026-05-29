/**
 * Lightweight relative time formatter used by the feed "Updated …" indicator.
 *
 * Kept dependency-free and pure so it can be safely called from render paths
 * (it is referenced once per tick in {@link useRelativeTime}) without any
 * I/O or allocation pressure.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Format a timestamp (ISO string, ms, or Date) as a short relative string,
 * styled similarly to Opera News / Google News:
 *
 *   - "just now"          (< 60 s)
 *   - "2 mins ago"        (< 60 min)
 *   - "1 hour ago"        (< 24 h)
 *   - "3 days ago"        (>= 24 h)
 *
 * Returns `null` if the input is missing or unparseable so that callers can
 * gracefully hide the indicator instead of rendering a junk value.
 */
export function formatRelativeTime(
  input: string | number | Date | null | undefined,
  now: number = Date.now(),
): string | null {
  if (input === null || input === undefined) return null;

  const ts =
    input instanceof Date
      ? input.getTime()
      : typeof input === 'number'
        ? input
        : Date.parse(input);

  if (!Number.isFinite(ts)) return null;

  // Clock-skew safety: if the server timestamp is slightly in the future
  // (common with Postgres `now()` vs. mobile clock drift), treat it as "now".
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));

  if (diffSec < 45) return 'just now';
  if (diffSec < 90) return '1 min ago';
  if (diffSec < HOUR) {
    const mins = Math.round(diffSec / MINUTE);
    return `${mins} mins ago`;
  }
  if (diffSec < 2 * HOUR) return '1 hour ago';
  if (diffSec < DAY) {
    const hours = Math.round(diffSec / HOUR);
    return `${hours} hours ago`;
  }
  if (diffSec < 2 * DAY) return '1 day ago';
  const days = Math.round(diffSec / DAY);
  return `${days} days ago`;
}
