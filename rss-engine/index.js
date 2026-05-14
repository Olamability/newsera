require('dotenv').config();

const supabase = require('./config/supabase');
const { fetchSources } = require('./src/fetchSources');
const { fetchRSS } = require('./src/fetchRSS');
const { deduplicateArticles } = require('./src/deduplicateArticles');
const { saveArticles } = require('./src/saveArticles');

const MIN_CONCURRENCY = 3;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 5;
const RAW_CONCURRENCY = parseInt(process.env.RSS_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10);
// Process at least 3 and at most 5 feeds at once (safe bounded concurrency).
const CONCURRENCY = Math.max(
  MIN_CONCURRENCY,
  Math.min(Number.isNaN(RAW_CONCURRENCY) ? DEFAULT_CONCURRENCY : RAW_CONCURRENCY, MAX_CONCURRENCY),
);
const RAW_BATCH_DELAY_MS = parseInt(process.env.RSS_BATCH_DELAY_MS || '300', 10);
const BATCH_DELAY_MS = Number.isNaN(RAW_BATCH_DELAY_MS) ? 300 : Math.max(0, RAW_BATCH_DELAY_MS);
const DEBUG = process.env.RSS_DEBUG === 'true';
let preferredLogPayloadIndex = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeIngestionLog(source, metrics) {
  const imageSuccessRate = metrics.fetched > 0
    ? Number((metrics.imageCount / metrics.fetched).toFixed(4))
    : 0;

  // Supports both the current `rss_ingestion_log` shape and older/newer
  // schema variants without changing database structure.
  const payloads = [
    {
      source_id: source.id,
      source_name: source.name,
      success: metrics.success,
      status: metrics.success ? 'success' : 'error',
      articles_fetched: metrics.fetched,
      articles_inserted: metrics.inserted,
      articles_skipped: metrics.duplicates,
      image_success_rate: imageSuccessRate,
      error_message: metrics.error,
      started_at: metrics.startedAt,
      finished_at: metrics.finishedAt,
    },
    {
      feed_id: source.id,
      feed_url: source.rss_url || '',
      started_at: metrics.startedAt,
      finished_at: metrics.finishedAt,
      articles_found: metrics.fetched,
      articles_saved: metrics.inserted,
      articles_skipped: metrics.duplicates,
      error: metrics.error,
      status: metrics.success ? 'success' : 'error',
    },
    {
      feed_url: source.rss_url || '',
      started_at: metrics.startedAt,
      finished_at: metrics.finishedAt,
      articles_found: metrics.fetched,
      articles_saved: metrics.inserted,
      articles_skipped: metrics.duplicates,
      error: metrics.error,
      status: metrics.success ? 'success' : 'error',
    },
  ];

  const orderedIndexes = [preferredLogPayloadIndex, ...payloads.map((_, idx) => idx).filter((idx) => idx !== preferredLogPayloadIndex)];
  for (const payloadIndex of orderedIndexes) {
    const payload = payloads[payloadIndex];
    try {
      const { error } = await supabase.from('rss_ingestion_log').insert([payload]);
      if (!error) {
        preferredLogPayloadIndex = payloadIndex;
        return;
      }
      if (DEBUG) {
        console.warn(`  [DEBUG] Ingestion log attempt failed for "${source.name}": ${error.message}`);
      }
    } catch (error) {
      if (DEBUG) {
        console.warn(`  [DEBUG] Ingestion log exception for "${source.name}": ${error.message}`);
      }
    }
  }

  console.warn(`  [WARN] Failed to write ingestion log for "${source.name}"`);
}

async function processSource(source) {
  console.log(`Processing source: "${source.name}" (${source.rss_url})`);

  const metrics = {
    success: false,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    imageCount: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  try {
    const articles = await fetchRSS(source);
    metrics.fetched = articles.length;
    metrics.imageCount = articles.filter((article) => !!article.image_url).length;
    console.log(`  [${source.name}] Fetched ${articles.length} article(s) from feed.`);

    if (!articles.length) {
      metrics.success = true;
      return metrics;
    }

    const { fresh, duplicateCount } = await deduplicateArticles(articles);
    metrics.duplicates += duplicateCount;
    if (DEBUG) {
      console.log(`  [DEBUG] ${source.name} in-feed duplicate check: skipped=${duplicateCount} remaining=${fresh.length}`);
    }

    if (!fresh.length) {
      metrics.success = true;
      return metrics;
    }

    const saved = await saveArticles(fresh);
    metrics.inserted = saved.inserted;
    metrics.duplicates += saved.skippedDuplicates;
    console.log(`  [${source.name}] Inserted ${saved.inserted} article(s), skipped ${metrics.duplicates} duplicate(s).`);
    if (DEBUG) {
      console.log(`  [DEBUG] ${source.name} dedup decisions: inserted=${saved.inserted} skipped=${metrics.duplicates}`);
    }

    metrics.success = true;
    return metrics;
  } catch (error) {
    metrics.error = error?.message ?? String(error);
    console.error(`  [ERROR] Source "${source.name}" failed: ${metrics.error}`);
    return metrics;
  } finally {
    metrics.finishedAt = new Date().toISOString();
    await writeIngestionLog(source, metrics);
  }
}

async function run() {
  console.log('=== Newsera RSS Ingestion Engine ===');
  console.log(`Started at: ${new Date().toISOString()}\n`);

  // 1. Fetch active sources
  console.log('Fetching active sources…');
  const sources = await fetchSources();
  console.log(`Found ${sources.length} active source(s). Concurrency: ${CONCURRENCY}, batch delay: ${BATCH_DELAY_MS}ms\n`);

  // 2. Process sources in bounded parallel batches.
  //    Promise.allSettled ensures one failed source never stops the others.
  const results = [];
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    const batchIndex = Math.floor(i / CONCURRENCY) + 1;
    if (DEBUG) {
      console.log(`  [DEBUG] Starting batch ${batchIndex} (${batch.length} source(s))`);
    }
    const batchResults = await Promise.allSettled(batch.map((source) => processSource(source)));
    results.push(...batchResults);
    if (i + CONCURRENCY < sources.length && BATCH_DELAY_MS > 0) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // 3. Aggregate metrics
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalFailed = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      totalInserted += result.value.inserted;
      totalDuplicates += result.value.duplicates;
      if (!result.value.success) totalFailed += 1;
    } else {
      totalFailed += 1;
      console.error(`  [ERROR] Source "${sources[i].name}" failed: ${result.reason?.message ?? result.reason}`);
    }
  }

  // 4. Summary log
  console.log('\n=== Run Summary ===');
  console.log(`Sources processed : ${sources.length}`);
  console.log(`Sources failed    : ${totalFailed}`);
  console.log(`Articles inserted : ${totalInserted}`);
  console.log(`Duplicates skipped: ${totalDuplicates}`);
  console.log(`Finished at       : ${new Date().toISOString()}`);
}

run().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
