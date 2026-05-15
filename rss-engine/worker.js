require('dotenv').config();

const { runIngestion } = require('./index');

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const RAW_INTERVAL_MS = parseInt(process.env.RSS_INGESTION_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
const INGESTION_INTERVAL_MS = Number.isNaN(RAW_INTERVAL_MS) ? DEFAULT_INTERVAL_MS : Math.max(60_000, RAW_INTERVAL_MS);

let isRunning = false;
let timer = null;

async function runCycle() {
  if (isRunning) {
    console.warn('[WORKER] Previous ingestion run still active; skipping overlapping cycle.');
    return;
  }

  isRunning = true;
  try {
    await runIngestion();
  } catch (error) {
    console.error(`[WORKER] Ingestion cycle failed: ${error?.message ?? String(error)}`);
  } finally {
    isRunning = false;
  }
}

async function startWorker() {
  console.log(`[WORKER] RSS worker started. Interval: ${INGESTION_INTERVAL_MS}ms`);
  await runCycle();
  timer = setInterval(() => {
    void runCycle();
  }, INGESTION_INTERVAL_MS);
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

process.on('SIGINT', () => {
  console.log('[WORKER] SIGINT received. Stopping worker.');
  stopWorker();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[WORKER] SIGTERM received. Stopping worker.');
  stopWorker();
  process.exit(0);
});

startWorker().catch((error) => {
  console.error(`[WORKER] Failed to start: ${error?.message ?? String(error)}`);
  process.exit(1);
});
