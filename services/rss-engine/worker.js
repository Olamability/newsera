const { startWorker } = require('../../rss-engine/worker');

startWorker().catch((error) => {
  console.error(`[RSS] Failed to start worker: ${error?.message ?? String(error)}`);
  process.exit(1);
});
