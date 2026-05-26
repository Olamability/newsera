/**
 * Tiny in-memory token-bucket rate limiter middleware.
 *
 * Sized for protecting the moderation API from runaway clients / scraping.
 * In production behind a load balancer with multiple instances, replace
 * the in-memory map with a shared store (e.g. Redis) — but having a local
 * limiter is still useful as a per-process safety net.
 */
export function rateLimit({
  windowMs = 60_000,
  max = 120,
  keyFn = (req) => req.header('x-actor-id') || req.ip || 'anon',
} = {}) {
  const buckets = new Map();
  // Periodically drop stale buckets so the map doesn't grow unbounded.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs * 2;
    for (const [k, v] of buckets) if (v.resetAt < cutoff) buckets.delete(k);
  }, windowMs).unref?.();

  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - b.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(b.resetAt / 1000)));
    if (b.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    return next();
    // (sweep is intentionally not awaited; it's a background timer)
    void sweep;
  };
}
