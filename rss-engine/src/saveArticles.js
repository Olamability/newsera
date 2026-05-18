const supabase = require('../config/supabase');
const { computeIngestionKey } = require('../utils/ingestionKey');

const BATCH_SIZE = parseInt(process.env.INSERT_BATCH_SIZE || '50', 10);

function emitStructuredLog(level, message, fields) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: 'rss-worker',
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Save a batch of normalized articles with DB-backed ingestion idempotency.
 *
 * Idempotency model:
 *   1. Compute a deterministic ingestion_key per article (source_id + external
 *      id, or hashed url fallback).
 *   2. Pre-check the DB by `url` (which carries the existing UNIQUE
 *      constraint and index) — any hit is logged as duplicate_ingestion_skipped
 *      and removed from the insert set.
 *   3. The remaining rows are inserted via an atomic upsert with
 *      ON CONFLICT (url) DO NOTHING, which closes the race window between the
 *      pre-check and the insert (two workers, restart mid-batch, etc.).
 *
 * The optional `context` argument carries trace metadata so that every log
 * line emitted here can be correlated with the feed batch that produced it.
 */
async function saveArticles(articles, context = {}) {
  if (!articles.length) {
    return {
      inserted: 0,
      skippedDuplicates: 0,
      failedBatches: 0,
      errorMessage: null,
    };
  }

  const traceId = context.trace_id || null;
  const workerId = context.worker_id || null;

  let inserted = 0;
  let skippedDuplicates = 0;
  let failedBatches = 0;
  let errorMessage = null;

  for (let index = 0; index < articles.length; index += BATCH_SIZE) {
    const batch = articles.slice(index, index + BATCH_SIZE);

    // Annotate each article with its ingestion key (used for logging + the
    // pre-insert dedup lookup). Drop unrecoverable rows that have neither a
    // URL nor an external identifier.
    const annotated = batch
      .map((article) => ({
        article,
        ingestion_key: computeIngestionKey(article),
      }))
      .filter((entry) => entry.article && entry.article.url && entry.ingestion_key);

    if (annotated.length === 0) {
      continue;
    }

    // DB-backed idempotency pre-check: any URL already present in `articles`
    // is a duplicate we must skip. The unique index on `articles.url` makes
    // this lookup cheap and is the authoritative source of truth across
    // workers and restarts.
    const urls = annotated.map((entry) => entry.article.url);
    const existing = new Set();
    const { data: existingRows, error: lookupError } = await supabase
      .from('articles')
      .select('url')
      .in('url', urls);

    if (lookupError) {
      emitStructuredLog('warn', 'ingestion_dedup_lookup_failed', {
        worker_id: workerId,
        trace_id: traceId,
        error: lookupError.message,
        batch_size: annotated.length,
      });
      // Fall through to the upsert path; ON CONFLICT (url) is still atomic.
    } else if (Array.isArray(existingRows)) {
      for (const row of existingRows) {
        if (row && row.url) existing.add(row.url);
      }
    }

    const fresh = [];
    for (const entry of annotated) {
      if (existing.has(entry.article.url)) {
        skippedDuplicates += 1;
        emitStructuredLog('info', 'duplicate_ingestion_skipped', {
          worker_id: workerId,
          trace_id: traceId,
          source_id: entry.article.source_id || null,
          ingestion_key: entry.ingestion_key,
        });
        continue;
      }
      fresh.push(entry);
    }

    if (fresh.length === 0) {
      continue;
    }

    const rows = fresh.map(({ article }) => ({
      source_id: article.source_id,
      category_id: article.category_id,
      title: article.title,
      snippet: article.snippet || null,
      content: article.content || null,
      url: article.url,
      image_url: article.image_url || null,
      published_at: article.published_at || null,
    }));

    const { error, count } = await supabase
      .from('articles')
      .upsert(rows, { onConflict: 'url', ignoreDuplicates: true, count: 'exact' });

    if (error) {
      failedBatches += 1;
      errorMessage = error.message;
      emitStructuredLog('error', 'insert_batch_failed', {
        worker_id: workerId,
        trace_id: traceId,
        error: error.message,
        batch_size: rows.length,
      });
      continue;
    }

    const insertedInBatch = count ?? 0;
    inserted += insertedInBatch;
    // Any rows the atomic upsert dropped raced past our pre-check — count
    // them as duplicates so the per-feed totals stay accurate.
    skippedDuplicates += Math.max(rows.length - insertedInBatch, 0);
  }

  return {
    inserted,
    skippedDuplicates,
    failedBatches,
    errorMessage,
  };
}

module.exports = { saveArticles };
