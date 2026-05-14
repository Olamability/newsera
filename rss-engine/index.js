require('dotenv').config();

const pLimit = require('p-limit');
const { fetchSources } = require('./src/fetchSources');
const { fetchRSS } = require('./src/fetchRSS');
const { deduplicateArticles } = require('./src/deduplicateArticles');
const { saveArticles } = require('./src/saveArticles');

// Maximum number of RSS sources processed concurrently.
const CONCURRENCY = parseInt(process.env.RSS_CONCURRENCY || '5', 10);

async function processSource(source) {
  console.log(`Processing source: "${source.name}" (${source.rss_url})`);

  const articles = await fetchRSS(source);
  console.log(`  [${source.name}] Fetched ${articles.length} article(s) from feed.`);

  if (!articles.length) return { inserted: 0, duplicates: 0 };

  const { fresh, duplicateCount } = await deduplicateArticles(articles);
  console.log(`  [${source.name}] ${duplicateCount} duplicate(s) skipped, ${fresh.length} new article(s) to insert.`);

  if (!fresh.length) return { inserted: 0, duplicates: duplicateCount };

  const inserted = await saveArticles(fresh);
  console.log(`  [${source.name}] Inserted ${inserted} article(s).`);

  return { inserted, duplicates: duplicateCount };
}

async function run() {
  console.log('=== Newsera RSS Ingestion Engine ===');
  console.log(`Started at: ${new Date().toISOString()}\n`);

  // 1. Fetch active sources
  console.log('Fetching active sources…');
  const sources = await fetchSources();
  console.log(`Found ${sources.length} active source(s). Concurrency: ${CONCURRENCY}\n`);

  const limit = pLimit(CONCURRENCY);

  // 2. Process all sources in parallel (up to CONCURRENCY at a time).
  //    Promise.allSettled ensures one failed source never stops the others.
  const results = await Promise.allSettled(
    sources.map((source) => limit(() => processSource(source))),
  );

  // 3. Aggregate metrics
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalFailed = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      totalInserted += result.value.inserted;
      totalDuplicates += result.value.duplicates;
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
