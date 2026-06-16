import * as ExpoLinking from 'expo-linking';
import { ShareContent } from 'react-native';
import { NewsArticle } from '../types';
import { buildShareTrackedUrl } from './outboundClickService';

const APP_NAME = 'NewsEra';

export const UNKNOWN_SOURCE_LABEL = 'Unknown source';

/**
 * Resolve the human-readable source name for an article.
 *
 * Treats blank/whitespace-only strings as missing so we never render an
 * empty source pill. Falls back to {@link UNKNOWN_SOURCE_LABEL} only when
 * the article truly has no source name available.
 */
export function resolveArticleSourceName(article: NewsArticle): string {
  const direct = typeof article.source_name === 'string' ? article.source_name.trim() : '';
  if (direct) return direct;
  const joined = typeof article.sources?.name === 'string' ? article.sources.name.trim() : '';
  if (joined) return joined;
  return UNKNOWN_SOURCE_LABEL;
}

export function getArticleAppLink(articleId: string): string {
  return ExpoLinking.createURL(`article/${articleId}`);
}

export function buildArticleShareContent(article: NewsArticle): ShareContent {
  const sourceName = resolveArticleSourceName(article);
  const appLink = getArticleAppLink(article.id);

  // Raw publisher URL (website homepage preferred, article URL as fallback)
  const rawPublisherUrl = article.sources?.website_url ?? article.url;

  // Append share-specific UTM params so GA4 distinguishes user shares from
  // organic aggregator traffic:
  //   utm_source=newsera  utm_medium=share  utm_campaign=user_share
  const trackedPublisherUrl = buildShareTrackedUrl(rawPublisherUrl);

  const message = [
    `Read this article on ${APP_NAME}`,
    '',
    article.title,
    '',
    `Source: ${sourceName}`,
    '',
    `Open in app: ${appLink}`,
    '',
    `Source website: ${trackedPublisherUrl}`,
  ].join('\n');

  return {
    title: article.title,
    message,
    url: appLink,
  };
}
