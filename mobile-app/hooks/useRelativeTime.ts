import { useEffect, useState } from 'react';
import { formatRelativeTime } from '../services/relativeTime';

/**
 * Subscribes to a periodic tick and returns the relative-time string for the
 * supplied timestamp. The label is recomputed on each tick but only triggers
 * a re-render when the formatted string actually changes, keeping the
 * surrounding feed entirely free of timer-driven re-renders.
 *
 * Designed for the "Updated …" indicator at the top of the feed.
 */
export function useRelativeTime(
  timestamp: string | number | Date | null | undefined,
  refreshIntervalMs: number = 30_000,
): string | null {
  const [label, setLabel] = useState<string | null>(() =>
    formatRelativeTime(timestamp),
  );

  useEffect(() => {
    // Re-evaluate immediately whenever the source timestamp changes so the
    // first paint after a refresh shows "just now" instead of a stale value.
    setLabel(formatRelativeTime(timestamp));

    if (timestamp === null || timestamp === undefined) return undefined;

    const tick = () => {
      const next = formatRelativeTime(timestamp);
      // Only trigger a re-render when the string actually changes — avoids
      // wasted renders on an idle feed.
      setLabel((prev) => (prev === next ? prev : next));
    };

    const id = setInterval(tick, refreshIntervalMs);
    return () => clearInterval(id);
  }, [timestamp, refreshIntervalMs]);

  return label;
}
