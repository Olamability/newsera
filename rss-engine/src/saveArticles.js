const supabase = require('../config/supabase');

const BATCH_SIZE = parseInt(process.env.INSERT_BATCH_SIZE || '50', 10);
const DEBUG = process.env.RSS_DEBUG === 'true';

/**
 * Inserts an array of articles into the `articles` table.
 * Uses upsert with ignoreDuplicates so that concurrent ingestion runs cannot
 * crash on duplicate-URL constraint violations (Task 7 — deduplication race).
 * Articles are inserted in batches to stay within Supabase limits.
 * @param {Array} articles
 * @returns {Promise<{ inserted: number, skippedDuplicates: number }>}
 */
async function saveArticles(articles) {
  if (!articles.length) return { inserted: 0, skippedDuplicates: 0 };

  let inserted = 0;
  let skippedDuplicates = 0;

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

    // onConflict: 'url'  →  ON CONFLICT (url) DO NOTHING
    // ignoreDuplicates: true prevents any fields from being overwritten on
    // conflict, and suppresses errors for rows that already exist.
    const { error, count } = await supabase
      .from('articles')
      .upsert(rows, { onConflict: 'url', ignoreDuplicates: true, count: 'exact' });

    if (error) {
      console.error(`  [ERROR] Insert batch failed: ${error.message}`);
    } else {
      const insertedInBatch = count ?? 0;
      inserted += insertedInBatch;
      skippedDuplicates += Math.max(rows.length - insertedInBatch, 0);
      if (DEBUG) {
        console.log(`  [DEBUG] Batch insert attempted=${rows.length} inserted=${insertedInBatch} duplicates=${Math.max(rows.length - insertedInBatch, 0)}`);
      }
    }
  }

  return { inserted, skippedDuplicates };
}

module.exports = { saveArticles };
