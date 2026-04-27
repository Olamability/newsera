const RSSParser = require('rss-parser');

const SNIPPET_MAX_LENGTH = 500;
const CONTENT_MAX_LENGTH = 1500;

const parser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure', 'enclosure', { keepArray: false }],
    ],
  },
});

/**
 * Extracts the first 2–3 paragraphs from an HTML/text string.
 * Returns plain text with no HTML tags.
 * @param {string} raw
 * @returns {string}
 */
function extractSnippet(raw) {
  if (!raw) return '';

  // Strip HTML tags
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Split into sentences / paragraphs and take ~500 chars
  return text.length > SNIPPET_MAX_LENGTH ? text.slice(0, SNIPPET_MAX_LENGTH).replace(/\s\S*$/, '…') : text;
}

/**
 * Extracts the first few paragraphs (up to ~1500 chars) as content.
 * @param {string} raw
 * @returns {string}
 */
function extractContent(raw) {
  if (!raw) return '';

  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();

  return text.length > CONTENT_MAX_LENGTH ? text.slice(0, CONTENT_MAX_LENGTH).replace(/\s\S*$/, '…') : text;
}

/**
 * Tries to find an image URL from an RSS feed item.
 * @param {Object} item
 * @returns {string|null}
 */
function extractImage(item) {
  if (item.mediaContent && item.mediaContent.$) {
    return item.mediaContent.$.url || null;
  }
  if (item.mediaThumbnail && item.mediaThumbnail.$) {
    return item.mediaThumbnail.$.url || null;
  }
  if (item.enclosure && item.enclosure.url) {
    const mime = item.enclosure.type || '';
    if (mime.startsWith('image/')) return item.enclosure.url;
  }
  // Try to extract first <img> src from content
  const contentRaw = item['content:encoded'] || item.content || item.summary || '';
  const match = contentRaw.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match) return match[1];

  return null;
}

/**
 * Fetches and parses an RSS feed for a given source.
 * @param {{ id: string, name: string, rss_url: string, category_id: string }} source
 * @returns {Promise<Array>} Array of normalised article objects.
 */
async function fetchRSS(source) {
  if (!source.rss_url) {
    console.warn(`  [WARN] Source "${source.name}" has no rss_url — skipping.`);
    return [];
  }

  let feed;
  try {
    feed = await parser.parseURL(source.rss_url);
  } catch (err) {
    console.error(`  [ERROR] Failed to fetch RSS for "${source.name}": ${err.message}`);
    return [];
  }

  return (feed.items || []).map((item) => {
    const rawContent = item['content:encoded'] || item.content || item.summary || '';

    return {
      source_id: source.id,
      category_id: source.category_id,
      title: (item.title || '').trim(),
      url: (item.link || item.guid || '').trim(),
      snippet: extractSnippet(rawContent),
      content: extractContent(rawContent),
      image_url: extractImage(item),
      published_at: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    };
  }).filter((a) => a.url && a.title);
}

module.exports = { fetchRSS };
