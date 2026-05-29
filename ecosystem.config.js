module.exports = {
  apps: [
    {
      // Legacy interval-based worker. Kept as a fallback for deployments
      // that have not yet flipped the queue_based_ingestion feature flag.
      name: 'rss-engine',
      script: './services/rss-engine/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      merge_logs: true,
      time: true,
    },
    {
      // Production lease-based worker (rss-worker:v2). This is the canonical
      // ingestion runtime — start it explicitly with:
      //   pm2 start ecosystem.config.js --only rss-worker
      name: 'rss-worker',
      script: 'node_modules/.bin/tsx',
      args: 'workers/rss-worker.ts',
      cwd: './rss-engine',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Restart the worker if its RSS state machine ever leaks memory.
      // The lease-based worker is steady around ~150 MB; 512 MB is a
      // safe ceiling that triggers well before the OOM killer.
      max_memory_restart: '512M',
      // Exponential backoff on crash so a misconfigured environment
      // (e.g. wrong Supabase key) doesn't spin the process forever.
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: '30s',
      kill_timeout: 35000, // > RSS_SHUTDOWN_GRACE_MS so the worker can drain
      wait_ready: false,
      env: {
        NODE_ENV: 'production',
      },
      // Per-app log files (rotated by pm2-logrotate, see docs).
      out_file: './logs/rss-worker.out.log',
      error_file: './logs/rss-worker.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};

