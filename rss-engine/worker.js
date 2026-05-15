require('dotenv').config();

const { runIngestion } = require('./index');

const INGESTION_INTERVAL_MS = 10 * 60 * 1000;

let isRunning = false;
let timer = null;

async function runCycle() {
  if (isRunning) {
    console.warn('[RSS] Previous cycle still running — skipped');
    return;
  }

  isRunning = true;
  console.log('[RSS] Starting ingestion cycle');

  try {
    await runIngestion();
  } catch (error) {
    console.error(`[RSS] Ingestion cycle failed: ${error?.message ?? String(error)}`);
  } finally {
    isRunning = false;
  }
}

async function startWorker() {
  await runCycle();
  timer = setInterval(() => {
    void runCycle();
  }, INGESTION_INTERVAL_MS);
}

function stopWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

process.on('SIGINT', () => {
  stopWorker();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopWorker();
  process.exit(0);
});

if (require.main === module) {
  startWorker().catch((error) => {
    console.error(`[RSS] Failed to start worker: ${error?.message ?? String(error)}`);
    process.exit(1);
  });
}

module.exports = { startWorker, stopWorker, runCycle };
