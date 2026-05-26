import { processEvent } from './engine.js';

/**
 * Long-running worker entrypoint. In production this consumes from the
 * platform's event bus; here we expose `processEvent` for callers and provide
 * a minimal loop placeholder. The integration with the actual bus (queue or
 * Supabase realtime) is environment-specific.
 */
async function main() {
  console.log('[fraud] engine started (shadow-mode by default)');
  console.log('[fraud] waiting for events…');
  // Concrete consumers (kafka/sqs/realtime) plug in here. Keeping the loop
  // empty avoids accidentally running compute on a misconfigured environment.
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  main().catch((e) => {
    console.error('[fraud] fatal', e);
    process.exit(1);
  });
}

export { processEvent };
