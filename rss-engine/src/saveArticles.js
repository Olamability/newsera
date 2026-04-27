const supabase = require('../config/supabase');

/**
 * Inserts an array of new articles into the `news` table.
 * Articles are inserted in batches to stay within Supabase limits.
 * @param {Array} articles
 * @returns {Promise<number>} Number of articles successfully inserted.
 */
async function saveArticles(articles) {
  if (!articles.length) return 0;

  const BATCH_SIZE = 50;
  let inserted = 0;

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);

    const rows = batch.map((a) => ({
      source_id: a.source_id,
      category_id: a.category_id,
      title: a.title,
      snippet: a.snippet || null,
      content: a.content || null,
      url: a.url,
      image_url: a.image_url || null,
      published_at: a.published_at || null,
    }));

    const { error, count } = await supabase
      .from('news')
      .insert(rows, { count: 'exact' });

    if (error) {
      // Log but continue with next batch
      console.error(`  [ERROR] Insert batch failed: ${error.message}`);
    } else {
      inserted += count ?? batch.length;
    }
  }

  return inserted;
}

module.exports = { saveArticles };
