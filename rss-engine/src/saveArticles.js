const supabase = require('../config/supabase');

const BATCH_SIZE = parseInt(process.env.INSERT_BATCH_SIZE || '50', 10);

async function saveArticles(articles) {
  if (!articles.length) {
    return {
      inserted: 0,
      skippedDuplicates: 0,
      failedBatches: 0,
      errorMessage: null,
    };
  }

  let inserted = 0;
  let skippedDuplicates = 0;
  let failedBatches = 0;
  let errorMessage = null;

  for (let index = 0; index < articles.length; index += BATCH_SIZE) {
    const batch = articles.slice(index, index + BATCH_SIZE);
    const rows = batch.map((article) => ({
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
      console.error(`[RSS] Insert batch failed: ${error.message}`);
      continue;
    }

    const insertedInBatch = count ?? 0;
    inserted += insertedInBatch;
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
