const supabase = require('../config/supabase');

/**
 * Removes articles whose URLs already exist in the `news` table.
 * @param {Array} articles - Candidate articles to check.
 * @returns {Promise<{ fresh: Array, duplicateCount: number }>}
 */
async function deduplicateArticles(articles) {
  if (!articles.length) {
    return { fresh: [], duplicateCount: 0 };
  }

  const urls = articles.map((a) => a.url);

  const { data, error } = await supabase
    .from('news')
    .select('url')
    .in('url', urls);

  if (error) {
    throw new Error(`Failed to check for duplicate URLs: ${error.message}`);
  }

  const existingUrls = new Set((data || []).map((row) => row.url));
  const fresh = articles.filter((a) => !existingUrls.has(a.url));

  return {
    fresh,
    duplicateCount: articles.length - fresh.length,
  };
}

module.exports = { deduplicateArticles };
