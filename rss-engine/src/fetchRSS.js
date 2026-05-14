const RSSParser = require('rss-parser');

const SNIPPET_MAX_LENGTH = 500;
const CONTENT_MAX_LENGTH = 1500;
// Maximum time (ms) to wait for a single RSS feed before giving up.
const FETCH_TIMEOUT_MS = parseInt(process.env.RSS_FETCH_TIMEOUT_MS || '30000', 10);
// Minimum image dimension threshold to filter out tracking pixels / icons.
const MIN_IMAGE_DIMENSION = 100;
// Known path segments that indicate non-content images.
const SKIP_IMAGE_PATTERNS = [
  /tracking/i,
  /pixel/i,
  /beacon/i,
  /icon/i,
  /logo/i,
  /avatar/i,
  /badge/i,
  /button/i,
  /sprite/i,
  /banner/i,
  /ad[_-]/i,
  /\/ads\//i,
];

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
 * Returns true if the URL looks like a tracking pixel, icon, or other
 * non-article image that should be ignored.
 * @param {string} url
 * @returns {boolean}
 */
function isLowQualityImage(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    if (SKIP_IMAGE_PATTERNS.some((re) => re.test(path))) return true;
    // Reject tiny GIF/PNG beacons (1x1 px) sometimes encoded in the URL
    if (/[?&](w|h|width|height)=1(&|$)/i.test(u.search)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Tries to find an image URL from an RSS feed item.
 * Priority order:
 *   1. media:content (WordPress preferred)
 *   2. media:thumbnail
 *   3. enclosure (image/* only)
 *   4. og:image / first meaningful <img> in content
 * Skips tracking pixels, icons, logos, and other low-quality images.
 * @param {Object} item
 * @returns {string|null}
 */
function extractImage(item) {
  // 1. media:content
  const mcUrl = item?.mediaContent?.$?.url;
  if (mcUrl && !isLowQualityImage(mcUrl)) return mcUrl;

  // 2. media:thumbnail
  const mtUrl = item?.mediaThumbnail?.$?.url;
  if (mtUrl && !isLowQualityImage(mtUrl)) return mtUrl;

  // 3. enclosure (must be an image MIME type)
  if (item?.enclosure?.url && item.enclosure.type?.startsWith('image/')) {
    if (!isLowQualityImage(item.enclosure.url)) return item.enclosure.url;
  }

  // 4. Scan content HTML for a meaningful image
  const contentRaw =
    item['content:encoded'] ||
    item.content ||
    item.summary ||
    item.description ||
    '';

  // Try src from <img> tags — pick the first one that passes the quality check.
  // Use two separate patterns (double-quoted / single-quoted) to avoid
  // incorrectly matching across mismatched quote types.
  const imgTagPatterns = [
    /<img[^>]+src="([^"]+)"[^>]*>/gi,
    /<img[^>]+src='([^']+)'[^>]*>/gi,
  ];
  let match;
  for (const imgTagRe of imgTagPatterns) {
    imgTagRe.lastIndex = 0;
    while ((match = imgTagRe.exec(contentRaw)) !== null) {
      const url = match[1];
      const tagStr = match[0];
      const widthMatch = /width=["']?(\d+)/i.exec(tagStr);
      const heightMatch = /height=["']?(\d+)/i.exec(tagStr);
      if (widthMatch && parseInt(widthMatch[1], 10) < MIN_IMAGE_DIMENSION) continue;
      if (heightMatch && parseInt(heightMatch[1], 10) < MIN_IMAGE_DIMENSION) continue;
      if (!isLowQualityImage(url)) return url;
    }
  }

  // Fallback: bare image URL in content (WordPress / CDN style)
  const bareRe = /https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)(?:[?#][^\s"'<>]*)?/gi;
  while ((match = bareRe.exec(contentRaw)) !== null) {
    const url = match[0];
    if (!isLowQualityImage(url)) return url;
  }

  return null;
}

/**
 * Fetches and parses an RSS feed for a given source with a configurable timeout.
 * One failed/slow source never blocks the rest of the ingestion pipeline.
 * @param {{ id: string, name: string, rss_url: string, category_id: string }} source
 * @returns {Promise<Array>} Array of normalised article objects.
 */
async function fetchRSS(source) {
  if (!source.rss_url) {
    console.warn(`  [WARN] Source "${source.name}" has no rss_url — skipping.`);
    return [];
  }

  let feed;
  const ingestionTime = new Date().toISOString();

  try {
    // parseURL does not natively support AbortController, so we race it against
    // a rejection timer to enforce the configurable timeout.
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms`)),
        FETCH_TIMEOUT_MS,
      );
    });
    feed = await Promise.race([
      parser.parseURL(source.rss_url).then((result) => {
        clearTimeout(timeoutId);
        return result;
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    const isTimeout = err.message && err.message.startsWith('Timed out');
    if (isTimeout) {
      console.warn(`  [TIMEOUT] "${source.name}" did not respond within ${FETCH_TIMEOUT_MS}ms — skipping.`);
    } else {
      console.error(`  [ERROR] Failed to fetch RSS for "${source.name}": ${err.message}`);
    }
    return [];
  }

  return (feed.items || []).map((item) => {
    const rawContent = item['content:encoded'] || item.content || item.summary || '';

    // Task 9: fall back to the ingestion timestamp when pubDate is absent or
    // unparseable so that articles without a date never float to the top of
    // feeds ordered by published_at DESC.
    let publishedAt = ingestionTime;
    if (item.pubDate) {
      const parsed = new Date(item.pubDate);
      if (!Number.isNaN(parsed.getTime())) {
        publishedAt = parsed.toISOString();
      }
    }

    return {
      source_id: source.id,
      category_id: source.category_id,
      title: (item.title || '').trim(),
      url: (item.link || item.guid || '').trim(),
      snippet: extractSnippet(rawContent),
      content: extractContent(rawContent),
      image_url: extractImage(item),
      published_at: publishedAt,
    };
  }).filter((a) => a.url && a.title);
}

module.exports = { fetchRSS };
