require('dotenv').config();

const pLimit = require('p-limit');

const supabase = require('./config/supabase');
const { fetchSources } = require('./src/fetchSources');
const { fetchRSS } = require('./src/fetchRSS');
const { deduplicateArticles } = require('./src/deduplicateArticles');
const { saveArticles } = require('./src/saveArticles');

const SOURCE_CONCURRENCY = 5;
let preferredLogPayloadIndex = 0;

function buildStatus(success) {
  return success ? 'success' : 'error';
}

function buildDurationMs(startedAt, finishedAt) {
  return Math.max(new Date(finishedAt).getTime() - new Date(startedAt).getTime(), 0);
}

async function writeIngestionLog(source, metrics) {
  const payloads = [
    {
      source_id: source.id,
      source_name: source.name,
      articles_fetched: metrics.fetched,
      articles_inserted: metrics.inserted,
      duplicates_skipped: metrics.duplicates,
      failed_count: metrics.failedCount,
      duration_ms: metrics.durationMs,
      status: buildStatus(metrics.success),
      error_message: metrics.error,
      started_at: metrics.startedAt,
      finished_at: metrics.finishedAt,
    },
    {
      source_id: source.id,
      source_name: source.name,
      status: buildStatus(metrics.success),
      articles_fetched: metrics.fetched,
      articles_inserted: metrics.inserted,
      articles_skipped: metrics.duplicates,
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
      status: buildStatus(metrics.success),
    },
    {
      feed_url: source.rss_url || '',
      started_at: metrics.startedAt,
      finished_at: metrics.finishedAt,
      articles_found: metrics.fetched,
      articles_saved: metrics.inserted,
      articles_skipped: metrics.duplicates,
      error: metrics.error,
      status: buildStatus(metrics.success),
    },
  ];

  const orderedIndexes = [
    preferredLogPayloadIndex,
    ...payloads.map((_, index) => index).filter((index) => index !== preferredLogPayloadIndex),
  ];

  for (const payloadIndex of orderedIndexes) {
    try {
      const { error } = await supabase.from('rss_ingestion_log').insert([payloads[payloadIndex]]);
      if (!error) {
        preferredLogPayloadIndex = payloadIndex;
        return;
      }
    } catch {
      // Logging must never stop ingestion.
    }
  }

  console.warn(`[RSS] Ingestion log write failed: ${source.name}`);
}

async function processSource(source) {
  const metrics = {
    success: false,
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    failedCount: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: 0,
  };

  try {
    const articles = await fetchRSS(source);
    metrics.fetched = articles.length;

    if (articles.length === 0) {
      metrics.success = true;
      return metrics;
    }

    const { fresh, duplicateCount } = await deduplicateArticles(articles);
    metrics.duplicates += duplicateCount;
    if (duplicateCount > 0) {
      console.log(`[RSS] Duplicate skipped: ${source.name} (${duplicateCount})`);
    }

    if (fresh.length === 0) {
      metrics.success = true;
      return metrics;
    }

    const saved = await saveArticles(fresh);
    metrics.inserted = saved.inserted;
    metrics.duplicates += saved.skippedDuplicates;

    if (saved.skippedDuplicates > 0) {
      console.log(`[RSS] Duplicate skipped: ${source.name} (${saved.skippedDuplicates})`);
    }

    if (saved.failedBatches > 0) {
      metrics.error = saved.errorMessage || `Failed to save ${saved.failedBatches} batch(es)`;
      metrics.failedCount = 1;
      return metrics;
    }

    metrics.success = true;
    return metrics;
  } catch (error) {
    metrics.error = error?.message ?? String(error);
    metrics.failedCount = 1;
    console.error(`[RSS] Source failed: ${source.name} - ${metrics.error}`);
    return metrics;
  } finally {
    metrics.finishedAt = new Date().toISOString();
    metrics.durationMs = buildDurationMs(metrics.startedAt, metrics.finishedAt);
    await writeIngestionLog(source, metrics);
  }
}

async function refreshTrendingFeed() {
  try {
    const { error } = await supabase.rpc('refresh_trending_feed');
    if (error) {
      console.error(`[RSS] Trending refresh failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[RSS] Trending refresh failed: ${error?.message ?? String(error)}`);
    return false;
  }
}

async function runIngestion() {
  const sources = await fetchSources();
  const limit = pLimit(SOURCE_CONCURRENCY);
  const sourceTasks = sources.map((source) => limit(() => processSource(source)));
  const results = await Promise.allSettled(sourceTasks);

  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalFailed = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      totalInserted += result.value.inserted;
      totalDuplicates += result.value.duplicates;
      totalFailed += result.value.failedCount;
    } else {
      totalFailed += 1;
    }
  }

  if (totalInserted > 0) {
    await refreshTrendingFeed();
  }

  console.log(
    `[RSS] Ingestion completed (sources=${sources.length}, inserted=${totalInserted}, duplicates=${totalDuplicates}, failed=${totalFailed})`,
  );

  return {
    sourcesProcessed: sources.length,
    articlesInserted: totalInserted,
    duplicatesSkipped: totalDuplicates,
    failedSources: totalFailed,
  };
}

if (require.main === module) {
  runIngestion().catch((error) => {
    console.error(`[RSS] Fatal ingestion failure: ${error?.message ?? String(error)}`);
    process.exit(1);
  });
}

module.exports = { runIngestion };
