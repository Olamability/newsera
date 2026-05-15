const RSSParser = require('rss-parser');
const net = require('node:net');
const pLimit = require('p-limit');

const SNIPPET_MAX_LENGTH = 500;
const CONTENT_MAX_LENGTH = 1500;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 4_000;
const MIN_IMAGE_DIMENSION = 100;
const ARTICLE_IMAGE_LOOKUP_CONCURRENCY = 3;
const ARTICLE_PAGE_TIMEOUT_MS = 8_000;
const OG_IMAGE_META_REGEX = /<meta[^>]+(?:property=["']og:image["'][^>]+content=["']([^"']+)["']|content=["']([^"']+)["'][^>]+property=["']og:image["'])/i;
const IMG_TAG_REGEX = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
const NAMED_HTML_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};
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
const articleImageCache = new Map();

const parser = new RSSParser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['enclosure', 'enclosure', { keepArray: false }],
      ['wp:featured_image', 'wpFeaturedImage', { keepArray: true }],
      ['featured_image', 'featuredImage', { keepArray: true }],
      ['post-thumbnail', 'postThumbnail', { keepArray: true }],
    ],
  },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  if (!value) return '';

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = String(entity).toLowerCase();
    if (normalized.startsWith('#x')) {
      const codePoint = parseInt(normalized.slice(2), 16);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    if (normalized.startsWith('#')) {
      const codePoint = parseInt(normalized.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, normalized)
      ? NAMED_HTML_ENTITIES[normalized]
      : match;
  });
}

function stripHtml(value) {
  return value
    .replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function sanitizeText(value, maxLength) {
  if (!value) return '';
  const cleaned = normalizeWhitespace(decodeHtmlEntities(stripHtml(value)));
  if (!maxLength || cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).replace(/\s\S*$/, '…');
}

function sanitizeMaybeUrl(value) {
  if (!value) return null;
  const cleaned = decodeHtmlEntities(String(value)).trim();
  return cleaned || null;
}

function parseDimension(value) {
  if (value == null) return null;
  const parsed = parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isLowQualityImage(url, dimensions = {}) {
  const candidate = sanitizeMaybeUrl(url);
  if (!candidate) return true;
  if (candidate.startsWith('data:') || candidate.startsWith('javascript:') || candidate.startsWith('vbscript:')) return true;

  try {
    const parsed = new URL(candidate);
    const path = `${parsed.pathname}${parsed.search}`;
    if (SKIP_IMAGE_PATTERNS.some((pattern) => pattern.test(path))) return true;

    const width = parseDimension(dimensions.width ?? parsed.searchParams.get('w') ?? parsed.searchParams.get('width'));
    const height = parseDimension(dimensions.height ?? parsed.searchParams.get('h') ?? parsed.searchParams.get('height'));

    if ((width !== null && width < MIN_IMAGE_DIMENSION) || (height !== null && height < MIN_IMAGE_DIMENSION)) {
      return true;
    }

    if ((width === 1 && height === 1) || /(^|[?&])(w|h|width|height)=1(&|$)/i.test(parsed.search)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getImageCandidate(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { url: sanitizeMaybeUrl(entry), width: null, height: null };
  }

  const metadata = entry.$ || entry;
  return {
    url: sanitizeMaybeUrl(metadata.url || metadata.href || entry._),
    width: parseDimension(metadata.width),
    height: parseDimension(metadata.height),
    type: metadata.type,
  };
}

function pickImageFromField(value) {
  for (const entry of toArray(value)) {
    const candidate = getImageCandidate(entry);
    if (candidate?.url && !isLowQualityImage(candidate.url, candidate)) {
      return candidate.url;
    }
  }

  return null;
}

function pickEnclosureImage(value) {
  for (const entry of toArray(value)) {
    const candidate = getImageCandidate(entry);
    if (!candidate?.url) continue;
    if (candidate.type && !String(candidate.type).startsWith('image/')) continue;
    if (!isLowQualityImage(candidate.url, candidate)) {
      return candidate.url;
    }
  }

  return null;
}

function pickImageFromHtml(contentRaw) {
  IMG_TAG_REGEX.lastIndex = 0;
  let match;

  while ((match = IMG_TAG_REGEX.exec(contentRaw)) !== null) {
    const imageTag = match[0];
    const imageUrl = sanitizeMaybeUrl(match[1]);
    const width = parseDimension(/width=["']?(\d+)/i.exec(imageTag)?.[1]);
    const height = parseDimension(/height=["']?(\d+)/i.exec(imageTag)?.[1]);
    if (imageUrl && !isLowQualityImage(imageUrl, { width, height })) {
      return imageUrl;
    }
  }

  return null;
}

function isTimeoutError(error) {
  return error?.name === 'AbortError' || String(error?.message || '').startsWith('Timed out after');
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map((segment) => parseInt(segment, 10));
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true;
  const firstHextet = normalized.split(':').find((segment) => segment.length > 0) || '';
  if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true;
  return false;
}

function isBlockedHost(hostname) {
  if (!hostname) return true;
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 0) return false;
  if (ipVersion === 4) return isPrivateIPv4(normalized);
  return isPrivateIPv6(normalized);
}

function validateSourceUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'unsupported protocol' };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { valid: false, reason: 'blocked host' };
  }

  return { valid: true };
}

function sanitizeUrlForLog(url) {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function isTransientError(error) {
  const statusCode = error?.statusCode;
  if (typeof statusCode === 'number' && (statusCode === 429 || statusCode >= 500)) {
    return true;
  }

  if (isTimeoutError(error)) return true;

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('network')
    || message.includes('timed out')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('eai_again')
  );
}

async function fetchTextWithTimeout(url, timeoutMs, acceptHeader) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available');
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(url, {
      signal: controller?.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'newsera-rss-engine/1.0',
        Accept: acceptHeader,
      },
    });

    const redirectedValidation = validateSourceUrl(response.url || url);
    if (!redirectedValidation.valid) {
      throw new Error(`Blocked redirected URL (${redirectedValidation.reason})`);
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText} for ${sanitizeUrlForLog(url)}`);
      error.statusCode = response.status;
      throw error;
    }

    return response.text();
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchFeedDocument(source) {
  if (typeof fetch === 'function') {
    const xml = await fetchTextWithTimeout(
      source.rss_url,
      FETCH_TIMEOUT_MS,
      'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
    );

    return parser.parseString(xml);
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
  });

  return Promise.race([
    parser.parseURL(source.rss_url),
    timeoutPromise,
  ]).finally(() => clearTimeout(timeoutId));
}

async function fetchOpenGraphImage(articleUrl) {
  const sanitizedArticleUrl = sanitizeMaybeUrl(articleUrl);
  if (!sanitizedArticleUrl) return null;

  const cached = articleImageCache.get(sanitizedArticleUrl);
  if (cached) {
    return cached;
  }

  const validation = validateSourceUrl(sanitizedArticleUrl);
  if (!validation.valid || typeof fetch !== 'function') {
    const resolved = Promise.resolve(null);
    articleImageCache.set(sanitizedArticleUrl, resolved);
    return resolved;
  }

  const pending = (async () => {
    try {
      const html = await fetchTextWithTimeout(
        sanitizedArticleUrl,
        ARTICLE_PAGE_TIMEOUT_MS,
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      );
      const decodedHtml = decodeHtmlEntities(html);
      const match = decodedHtml.match(OG_IMAGE_META_REGEX);
      const candidate = sanitizeMaybeUrl(match?.[1] || match?.[2]);
      return candidate && !isLowQualityImage(candidate) ? candidate : null;
    } catch {
      return null;
    }
  })();

  articleImageCache.set(sanitizedArticleUrl, pending);
  const resolved = await pending;
  articleImageCache.set(sanitizedArticleUrl, Promise.resolve(resolved));
  return resolved;
}

async function extractImage(item, articleUrl) {
  const contentRaw = item['content:encoded'] || item.content || item.summary || item.description || '';

  const mediaContentImage = pickImageFromField(item?.mediaContent);
  if (mediaContentImage) return mediaContentImage;

  const mediaThumbnailImage = pickImageFromField(item?.mediaThumbnail);
  if (mediaThumbnailImage) return mediaThumbnailImage;

  const enclosureImage = pickEnclosureImage(item?.enclosure);
  if (enclosureImage) return enclosureImage;

  const openGraphImage = await fetchOpenGraphImage(articleUrl);
  if (openGraphImage) return openGraphImage;

  return pickImageFromHtml(contentRaw);
}

function parsePublishedAt(item) {
  const candidates = [item.isoDate, item.pubDate, item.published, item.updated, item['dc:date']];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}

async function normalizeArticle(item, source) {
  const rawContent = item['content:encoded'] || item.content || item.summary || item.description || '';
  const url = sanitizeMaybeUrl(item.link || item.guid || '');
  const title = sanitizeText(item.title || '', 0);

  if (!url || !title) {
    return null;
  }

  return {
    source_id: source.id,
    category_id: source.category_id,
    title,
    url,
    snippet: sanitizeText(rawContent, SNIPPET_MAX_LENGTH),
    content: sanitizeText(rawContent, CONTENT_MAX_LENGTH),
    image_url: await extractImage(item, url),
    published_at: parsePublishedAt(item),
  };
}

async function fetchRSS(source) {
  if (!source.rss_url) {
    throw new Error(`Source "${source.name}" has no rss_url`);
  }

  const urlValidation = validateSourceUrl(source.rss_url);
  if (!urlValidation.valid) {
    throw new Error(`Source "${source.name}" has unsafe rss_url (${urlValidation.reason})`);
  }

  let feed = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      feed = await fetchFeedDocument(source);
      break;
    } catch (error) {
      const transient = isTransientError(error);
      if (isTimeoutError(error)) {
        console.warn(`[RSS] Timeout: ${source.name}`);
      }

      if (transient && attempt < MAX_RETRIES) {
        const retryNumber = attempt + 1;
        const delayMs = Math.min(RETRY_BASE_DELAY_MS * (2 ** attempt), RETRY_MAX_DELAY_MS);
        console.warn(`[RSS] Retry ${retryNumber}/${MAX_RETRIES}: ${source.name}`);
        await sleep(delayMs);
        continue;
      }

      if (transient) {
        console.warn(`[RSS] Feed skipped after retries: ${source.name}`);
      }

      throw error;
    }
  }

  const limit = pLimit(ARTICLE_IMAGE_LOOKUP_CONCURRENCY);
  const normalized = await Promise.all(
    (feed?.items || []).map((item) => limit(() => normalizeArticle(item, source))),
  );

  return normalized.filter((article) => !!article);
}

module.exports = { fetchRSS };
