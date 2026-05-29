# Newsera RSS Worker — Production Deployment Guide

This document describes how to deploy and operate the **rss-worker:v2**
ingestion service in production. The worker is a lease-based, heartbeat-driven
runtime defined in `rss-engine/workers/rss-worker.ts` and orchestrated via
`tsx`. It is the canonical ingestion path for live RSS feeds.

Two equivalent deployment topologies are supported:

| Topology | Best for | Manifest |
|---|---|---|
| **Docker / Compose** | Single-host VPS, easy rebuilds, isolated runtime | `Dockerfile` + `docker-compose.yml` |
| **PM2** | Bare-metal VPS with existing Node.js tooling | `ecosystem.config.js` |

Pick one — running both at the same time will create competing workers
(harmless, but wasteful).

---

## 1. Prerequisites

* A Supabase project with migrations through `057_ingestion_jobs_observability_cleanup.sql` applied.
* The `queue_based_ingestion` feature flag enabled (rss-worker:v2 self-disables otherwise — see `rss-engine/workers/rss-worker.ts`).
* A non-root user on the host (`deploy`, `node`, …) with permission to read the repo and write the log directory.
* Outbound HTTPS to your Supabase URL and to every RSS feed origin.

### Required environment variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase REST/Realtime endpoint. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. **Server-only.** Never ship this to the mobile app. |
| `NODE_ENV` | Always `production`. |

### Optional tuning (sane defaults baked in)

| Variable | Default | Notes |
|---|---|---|
| `RSS_WORKER_ID` | `rss-${hostname}-${pid}-${rand}` | Set to a stable string under PM2/Docker to keep heartbeats traceable across restarts. |
| `RSS_HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat upsert cadence. |
| `RSS_CLAIM_INTERVAL_MS` | `5000` | Delay between successful claim cycles. |
| `RSS_IDLE_POLL_INTERVAL_MS` | `30000` | Backoff when no feeds are due. |
| `RSS_LEASE_BATCH_SIZE` | `5` | Feeds leased per claim. |
| `RSS_LEASE_SECONDS` | `300` | Lease window before reclaim. |
| `RSS_FEED_CONCURRENCY` | `3` | Concurrent fetches per batch. |
| `RSS_SHUTDOWN_GRACE_MS` | `30000` | Drain window on SIGTERM. |
| `HEALTHCHECK_MAX_ARTICLE_STALENESS_SEC` | `3600` | Healthcheck warns above this. |
| `HEALTHCHECK_REQUIRE_ACTIVE_WORKER` | `true` | Healthcheck fails if no live worker. |

Never commit `.env`. Use `.env.example` as the template.

---

## 2. Docker deployment (recommended for VPS)

### 2.1. Build and start

```bash
cp .env.example .env
$EDITOR .env                # fill SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

docker compose up -d --build
docker compose ps           # rss-worker should be "healthy" after ~1 min
```

The `Dockerfile` is a slim two-stage `node:20-alpine` image:

* Production-only `npm ci`, cache purged.
* Runs as the non-root `node` user.
* `tini` as PID 1 → clean SIGTERM propagation → graceful shutdown.
* `HEALTHCHECK` runs `node scripts/healthcheck.js` every 60s.

### 2.2. Operate

```bash
docker compose logs -f rss-worker          # tail structured JSON logs
docker compose restart rss-worker          # safe — heartbeat survives
docker compose pull && docker compose up -d --build  # rolling upgrade
docker compose down                        # stop everything
```

### 2.3. Healthcheck

The container is marked unhealthy when:

* `get_ingestion_health()` returns `active_workers = 0`, OR
* the freshest article is older than `HEALTHCHECK_MAX_ARTICLE_STALENESS_SEC`, OR
* Supabase is unreachable for 10s.

If migration 057 is not yet deployed, the healthcheck falls back to a direct
`worker_heartbeats` probe.

---

## 3. PM2 deployment (bare-metal VPS)

### 3.1. Install once per host

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2 pnpm
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### 3.2. Deploy

```bash
git clone https://github.com/Olamability/newsera.git
cd newsera
cp .env.example .env
$EDITOR .env
pnpm install
mkdir -p rss-engine/logs

pm2 start ecosystem.config.js --only rss-worker --env production
pm2 save
pm2 startup systemd       # follow the printed command to enable on boot
```

`ecosystem.config.js` configures the worker with:

* `autorestart: true`
* `max_memory_restart: 512M`
* `restart_delay: 5000` with `max_restarts: 20` and `min_uptime: 30s` (exponential-style backoff on crash loops)
* `kill_timeout: 35000` — longer than the worker's `RSS_SHUTDOWN_GRACE_MS` so in-flight leases drain cleanly
* Per-app log files in `rss-engine/logs/` rotated by `pm2-logrotate`

### 3.3. Operate

```bash
pm2 status                    # process table
pm2 logs rss-worker --lines 200
pm2 restart rss-worker        # graceful via SIGINT then SIGKILL after 35s
pm2 reload rss-worker         # same as restart for fork-mode workers
pm2 stop rss-worker
pm2 monit                     # live CPU/mem dashboard
```

### 3.4. Manual healthcheck

```bash
cd rss-engine
npm run health                # exits 0 if healthy, 1 otherwise
```

This is the same script Docker invokes via `HEALTHCHECK` and is safe to wire
into external uptime monitors (Healthchecks.io, UptimeRobot, …).

---

## 4. Supabase requirements

| Component | Status to confirm |
|---|---|
| `rss_feed_sources` | Seeded (migration `056_rss_feed_bootstrap_and_seeding.sql`). |
| `ingestion_jobs` | Observability columns + `get_ingestion_health()` RPC present (migration `057_ingestion_jobs_observability_cleanup.sql`). |
| `worker_heartbeats` | Exists (migration `040_rss_worker_health_and_feed_reliability.sql`). |
| Feature flag `queue_based_ingestion` | Enabled. The worker logs `feature_flag_disabled_exit` and shuts down cleanly otherwise. |

Quick sanity check from `psql` or the Supabase SQL editor:

```sql
SELECT * FROM get_ingestion_health();
SELECT worker_id, status, last_heartbeat_at
FROM worker_heartbeats
WHERE worker_type = 'rss_ingestion'
ORDER BY last_heartbeat_at DESC LIMIT 5;
```

---

## 5. Monitoring commands

```bash
# Articles ingested in the last hour (server-side)
psql "$SUPABASE_DB_URL" -c \
  "SELECT COUNT(*) FROM articles WHERE created_at > now() - interval '1 hour';"

# Failed feeds in the last 24 hours
psql "$SUPABASE_DB_URL" -c \
  "SELECT feed_id, last_error, last_run_at
     FROM ingestion_jobs
    WHERE COALESCE(status, last_status) = 'failed'
      AND COALESCE(completed_at, last_run_at) > now() - interval '24 hours'
    ORDER BY last_run_at DESC LIMIT 20;"

# Live worker logs (filter to ingestion job events)
docker compose logs -f rss-worker | grep -E 'ingestion_job_(started|success|failed)'
# or
pm2 logs rss-worker | grep -E 'ingestion_job_(started|success|failed)'
```

---

## 6. Troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| Worker exits with `feature_flag_disabled_exit` | `queue_based_ingestion` is off | Enable the feature flag in Supabase; the worker will start on the next boot. |
| `heartbeat_register_failed` in logs | Service-role key missing/invalid, or RLS denies upsert | Verify `SUPABASE_SERVICE_ROLE_KEY`; confirm `worker_heartbeats` RLS policies. |
| Healthcheck flapping with `no_active_workers` | Worker container restarted between heartbeats | Increase Docker `start_period` or `HEALTHCHECK_REQUIRE_ACTIVE_WORKER=false` for the first 5 minutes after deploy. |
| `lease_due_feeds_idle` repeatedly | No feeds eligible (all in backoff or `is_active=false`) | Inspect `rss_feed_sources.next_fetch_at` and `consecutive_failures`. |
| `record_outcome_failed` | RPC missing or permissions changed | Re-apply migration 040 and 057. |
| Container restarts on OOM | A pathological feed exceeds memory | Lower `RSS_FEED_CONCURRENCY` or `RSS_LEASE_BATCH_SIZE`; raise `mem_limit`. |
| Articles stop appearing in mobile app | Realtime channel disconnected | The hook auto-resubscribes; verify Supabase project realtime quota. |

### Capturing diagnostics for a bug report

```bash
docker compose logs --since 1h rss-worker > /tmp/rss-worker.log
# or
pm2 logs rss-worker --lines 2000 --nostream > /tmp/rss-worker.log

psql "$SUPABASE_DB_URL" -c "SELECT * FROM get_ingestion_health();" > /tmp/health.txt
```

Include both files when filing an issue.

---

## 7. Security checklist

* `SUPABASE_SERVICE_ROLE_KEY` is **server-only**. It must never appear in the
  mobile app bundle or the admin-panel front-end.
* `.env` is in `.gitignore`. Verify with `git check-ignore .env`.
* The Docker image runs as the unprivileged `node` user.
* `get_ingestion_health()` is `SECURITY DEFINER` but granted only to
  `authenticated` and `service_role` — never to `anon`.
* All migrations in this series are additive; rollback is a no-op (drop the
  trigger + new columns + RPC if absolutely needed).
