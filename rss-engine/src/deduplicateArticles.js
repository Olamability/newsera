/**
 * Removes duplicate URLs within the same ingestion batch only.
 * Database-level duplicate protection is handled atomically at insert time
 * via ON CONFLICT (url) DO NOTHING in saveArticles().
 * @param {Array} articles
 * @returns {Promise<{ fresh: Array, duplicateCount: number }>}
 */
async function deduplicateArticles(articles) {
  if (!articles.length) {
    return { fresh: [], duplicateCount: 0 };
  }

  const seen = new Set();
  const fresh = [];
  let duplicateCount = 0;

  for (const article of articles) {
    if (!article?.url) continue;
    if (seen.has(article.url)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(article.url);
    fresh.push(article);
  }

  return {
    fresh,
    duplicateCount,
  };
}

module.exports = { deduplicateArticles };
