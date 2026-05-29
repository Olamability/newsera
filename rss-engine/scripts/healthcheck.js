#!/usr/bin/env node
/**
 * rss-worker healthcheck script.
 *
 * Exits 0 if the ingestion pipeline appears healthy, 1 otherwise.
 *
 * Usage:
 *   node scripts/healthcheck.js
 *
 * Designed to be lightweight enough for a Docker HEALTHCHECK directive:
 * a single RPC call against Supabase, no heavy dependencies, no long
 * timeouts. Tunable via environment:
 *
 *   HEALTHCHECK_MAX_ARTICLE_STALENESS_SEC   default 3600 (1h)
 *   HEALTHCHECK_REQUIRE_ACTIVE_WORKER       default "true"
 *
 * The check uses the `get_ingestion_health()` RPC introduced in
 * migration 057. If the RPC is not yet deployed the check degrades
 * to a simple connectivity probe against the `worker_heartbeats`
 * table so the container still has a meaningful liveness signal.
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Healthcheck cannot run without credentials — treat as unhealthy so
  // the orchestrator surfaces the misconfiguration instead of silently
  // running a broken worker.
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'rss-worker-healthcheck',
      msg: 'missing_env',
      hint: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set',
    }),
  );
  process.exit(1);
}

const MAX_ARTICLE_STALENESS_SEC = Number(
  process.env.HEALTHCHECK_MAX_ARTICLE_STALENESS_SEC || 3600,
);
const REQUIRE_ACTIVE_WORKER =
  (process.env.HEALTHCHECK_REQUIRE_ACTIVE_WORKER || 'true').toLowerCase() !== 'false';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function emit(level, msg, fields = {}) {
  // Structured single-line output keeps Docker / journald / PM2 logs grep-able.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: 'rss-worker-healthcheck',
      msg,
      ...fields,
    }),
  );
}

async function fallbackProbe() {
  const { data, error } = await supabase
    .from('worker_heartbeats')
    .select('worker_id, status, last_heartbeat_at')
    .eq('worker_type', 'rss_ingestion')
    .eq('status', 'alive')
    .gte('last_heartbeat_at', new Date(Date.now() - 2 * 60 * 1000).toISOString())
    .limit(1);

  if (error) {
    emit('error', 'fallback_probe_failed', { error: error.message });
    process.exit(1);
  }

  if (!data || data.length === 0) {
    emit('warn', 'no_active_workers');
    process.exit(REQUIRE_ACTIVE_WORKER ? 1 : 0);
  }

  emit('info', 'healthy_fallback', { worker_id: data[0].worker_id });
  process.exit(0);
}

async function main() {
  const { data, error } = await supabase.rpc('get_ingestion_health');

  // RPC not yet deployed (migration 057 not run): fall back to a direct probe
  // so the container still has a working healthcheck.
  if (error && /function .* does not exist/i.test(error.message || '')) {
    emit('warn', 'health_rpc_missing_fallback', { error: error.message });
    await fallbackProbe();
    return;
  }

  if (error) {
    emit('error', 'health_rpc_failed', { error: error.message });
    process.exit(1);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    emit('error', 'health_rpc_empty');
    process.exit(1);
  }

  const reasons = [];

  if (REQUIRE_ACTIVE_WORKER && (row.active_workers ?? 0) < 1) {
    reasons.push('no_active_workers');
  }

  if (row.latest_article_at) {
    const ageSec = Math.floor((Date.now() - Date.parse(row.latest_article_at)) / 1000);
    if (Number.isFinite(ageSec) && ageSec > MAX_ARTICLE_STALENESS_SEC) {
      reasons.push(`article_stale_${ageSec}s`);
    }
  }

  if (reasons.length > 0) {
    emit('warn', 'unhealthy', { reasons, snapshot: row });
    process.exit(1);
  }

  emit('info', 'healthy', { snapshot: row });
  process.exit(0);
}

// Hard timeout so the container HEALTHCHECK never hangs forever.
const HEALTHCHECK_TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 10_000);
const timeout = setTimeout(() => {
  emit('error', 'timeout', { timeout_ms: HEALTHCHECK_TIMEOUT_MS });
  process.exit(1);
}, HEALTHCHECK_TIMEOUT_MS);
timeout.unref();

main().catch((err) => {
  emit('error', 'unhandled', { error: err?.message ?? String(err) });
  process.exit(1);
});
