const RSSParser = require('rss-parser');

const SNIPPET_MAX_LENGTH = 500;
const CONTENT_MAX_LENGTH = 1500;
const MIN_TIMEOUT_MS = 10000;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_TIMEOUT_MS = 15000;
// Maximum time (ms) to wait for a single RSS feed before giving up.
const RAW_TIMEOUT_MS = parseInt(process.env.RSS_FETCH_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
const FETCH_TIMEOUT_MS = Math.max(
  MIN_TIMEOUT_MS,
  Math.min(Number.isNaN(RAW_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : RAW_TIMEOUT_MS, MAX_TIMEOUT_MS),
);
// Minimum image dimension threshold to filter out tracking pixels / icons.
const MIN_IMAGE_DIMENSION = 100;
const DEBUG = process.env.RSS_DEBUG === 'true';
// Matches og:image meta tags where attributes can appear in either order:
// property="og:image" ... content="..." OR content="..." ... property="og:image".
const OG_IMAGE_META_REGEX = /<meta[^>]+(?:property=["']og:image["'][^>]+content=["']([^"']+)["']|content=["']([^"']+)["'][^>]+property=["']og:image["'])/i;
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
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['enclosure', 'enclosure', { keepArray: false }],
      ['wp:featured_image', 'wpFeaturedImage', { keepArray: true }],
      ['featured_image', 'featuredImage', { keepArray: true }],
      ['post-thumbnail', 'postThumbnail', { keepArray: true }],
      ['og:image', 'ogImage', { keepArray: false }],
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

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function pickImageFromField(value) {
  for (const entry of toArray(value)) {
    if (!entry) continue;
    // Handles common RSS/XML shapes: plain URL strings, { url/href }, and
    // namespaced parser objects like { $: { url } } or text nodes under "_".
    const url = typeof entry === 'string'
      ? entry
      : entry.url || entry.href || entry.$?.url || entry.$?.href || entry._;
    if (url && !isLowQualityImage(url)) {
      return url;
    }
  }
  return null;
}

/**
 * Tries to find an image URL from an RSS feed item.
 * Priority order:
 *   1. media:content
 *   2. enclosure (image/* only)
 *   3. og:image
 *   4. WordPress featured-image style fields
 *   5. HTML <img> fallback
 * Skips tracking pixels, icons, logos, and other low-quality images.
 * @param {Object} item
 * @returns {string|null}
 */
function extractImage(item) {
  // 1. media:content
  const mcUrl = pickImageFromField(item?.mediaContent);
  if (mcUrl) return mcUrl;

  // 2. enclosure (must be an image MIME type)
  if (item?.enclosure?.url && item.enclosure.type?.startsWith('image/')) {
    if (!isLowQualityImage(item.enclosure.url)) return item.enclosure.url;
  }

  // 3. og:image
  const contentRaw = item['content:encoded'] || item.content || item.summary || item.description || '';
  const ogImage =
    pickImageFromField(item?.ogImage) ||
    (() => {
      const match = contentRaw.match(OG_IMAGE_META_REGEX);
      const candidate = match?.[1] || match?.[2];
      return candidate && !isLowQualityImage(candidate) ? candidate : null;
    })();
  if (ogImage) return ogImage;

  // 4. WordPress featured image style fields (+ media thumbnail fallback)
  const wpImage =
    pickImageFromField(item?.wpFeaturedImage)
    || pickImageFromField(item?.featuredImage)
    || pickImageFromField(item?.postThumbnail)
    || pickImageFromField(item?.mediaThumbnail);
  if (wpImage) return wpImage;

  // 5. Scan content HTML for a meaningful image
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

  const canAbort = typeof fetch === 'function' && typeof AbortController === 'function';
  const controller = canAbort ? new AbortController() : null;
  const timeoutId = canAbort ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    if (typeof fetch === 'function') {
      const response = await fetch(source.rss_url, {
        signal: controller?.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'newsera-rss-engine/1.0',
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xml = await response.text();
      feed = await parser.parseString(xml);
    } else {
      let legacyTimeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        legacyTimeoutId = setTimeout(() => reject(new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
      });
      feed = await Promise.race([
        parser.parseURL(source.rss_url),
        timeoutPromise,
      ]).finally(() => clearTimeout(legacyTimeoutId));
    }
  } catch (err) {
    const isTimeout = err?.name === 'AbortError' || String(err?.message || '').startsWith('Timed out after');
    if (isTimeout) {
      console.warn(`  [TIMEOUT] "${source.name}" did not respond within ${FETCH_TIMEOUT_MS}ms — skipping.`);
    } else {
      console.error(`  [ERROR] Failed to fetch RSS for "${source.name}": ${err.message}`);
    }
    return [];
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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

    const imageUrl = extractImage(item);
    if (DEBUG) {
      console.log(`  [DEBUG] ${source.name} image extracted: ${imageUrl || 'none'} (${(item.title || '').trim() || 'untitled'})`);
    }

    return {
      source_id: source.id,
      category_id: source.category_id,
      title: (item.title || '').trim(),
      url: (item.link || item.guid || '').trim(),
      snippet: extractSnippet(rawContent),
      content: extractContent(rawContent),
      image_url: imageUrl,
      published_at: publishedAt,
    };
  }).filter((a) => a.url && a.title);
}

module.exports = { fetchRSS };
