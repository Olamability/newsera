/**
 * Deterministic ingestion-key generation for RSS articles.
 *
 * The ingestion key gives every article a stable identity at ingest time so
 * we can dedupe across worker restarts and lease re-claims without relying on
 * in-memory state. It is intentionally narrow: the canonical DB-level uniqueness
 * is still enforced by the existing `articles_url_unique` constraint — the
 * ingestion key augments that with structured trace/logging consistency and a
 * pre-insert lookup hook used by saveArticles().
 *
 * Format:
 *   `${source_id}:${external_article_id}`     when the feed exposes a stable ID
 *   `ext:${external_article_id}`              when only an external id is known
 *   `${source_id}:url:${sha256_128(article_url)}` fallback when only a URL is known
 *   `url:${sha256_128(article_url)}`          last-resort when source_id is missing
 *
 * The URL digest is the first 32 hex chars (128 bits) of SHA-256. That is more
 * than sufficient for collision-resistance in this namespace (keys are scoped
 * by `source_id` and only used to identify articles ingested by this worker),
 * and keeps the key short enough for compact log lines and structured fields.
 *
 * The key is always a short ASCII string safe for logs, DB lookups, and
 * structured metadata.
 */

const { createHash } = require('node:crypto');

function hashUrl(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

/**
 * Compute a deterministic ingestion key for an article-shaped object.
 * Accepts the same row shape used elsewhere in the pipeline:
 *   { source_id, url, external_id?, guid? }
 *
 * Returns `null` only when neither a URL nor an external identifier is
 * available — callers should treat that as an unrecoverable bad row and skip.
 */
function computeIngestionKey(article) {
  if (!article || typeof article !== 'object') return null;

  const sourceId = article.source_id ? String(article.source_id) : '';
  const externalId = article.external_id || article.guid || null;
  const url = article.url ? String(article.url) : '';

  if (externalId) {
    const trimmed = String(externalId).trim();
    if (trimmed) {
      return sourceId ? `${sourceId}:${trimmed}` : `ext:${trimmed}`;
    }
  }

  if (url) {
    const digest = hashUrl(url);
    return sourceId ? `${sourceId}:url:${digest}` : `url:${digest}`;
  }

  return null;
}

module.exports = { computeIngestionKey };
