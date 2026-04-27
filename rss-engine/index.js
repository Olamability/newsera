require('dotenv').config();

const { fetchSources } = require('./src/fetchSources');
const { fetchRSS } = require('./src/fetchRSS');
const { deduplicateArticles } = require('./src/deduplicateArticles');
const { saveArticles } = require('./src/saveArticles');

async function run() {
  console.log('=== Newsera RSS Ingestion Engine ===');
  console.log(`Started at: ${new Date().toISOString()}\n`);

  // 1. Fetch active sources
  console.log('Fetching active sources…');
  const sources = await fetchSources();
  console.log(`Found ${sources.length} active source(s).\n`);

  let totalInserted = 0;
  let totalDuplicates = 0;

  // 2. Process each source
  for (const source of sources) {
    console.log(`Processing source: "${source.name}" (${source.rss_url})`);

    // 3. Fetch RSS articles
    const articles = await fetchRSS(source);
    console.log(`  Fetched ${articles.length} article(s) from feed.`);

    if (!articles.length) continue;

    // 4. Deduplicate
    const { fresh, duplicateCount } = await deduplicateArticles(articles);
    console.log(`  ${duplicateCount} duplicate(s) skipped, ${fresh.length} new article(s) to insert.`);

    if (!fresh.length) continue;

    // 5. Save to Supabase
    const inserted = await saveArticles(fresh);
    console.log(`  Inserted ${inserted} article(s).`);

    totalInserted += inserted;
    totalDuplicates += duplicateCount;
  }

  // 6. Summary log
  console.log('\n=== Run Summary ===');
  console.log(`Sources processed : ${sources.length}`);
  console.log(`Articles inserted : ${totalInserted}`);
  console.log(`Duplicates skipped: ${totalDuplicates}`);
  console.log(`Finished at       : ${new Date().toISOString()}`);
}

run().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
