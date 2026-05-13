import * as ExpoLinking from 'expo-linking';
import { ShareContent } from 'react-native';
import { NewsArticle } from '../types';

const APP_NAME = 'Ability Digitalz News App';

export function resolveArticleSourceName(article: NewsArticle): string {
  return article.source_name ?? article.sources?.name ?? 'Unknown Source';
}

export function getArticleAppLink(articleId: string): string {
  return ExpoLinking.createURL(`article/${articleId}`);
}

export function buildArticleShareContent(article: NewsArticle): ShareContent {
  const sourceName = resolveArticleSourceName(article);
  const appLink = getArticleAppLink(article.id);
  const sourceWebsiteLink = article.sources?.website_url ?? article.url;

  const message = [
    `Read this article on ${APP_NAME}`,
    '',
    article.title,
    '',
    `Source: ${sourceName}`,
    '',
    `Open in app: ${appLink}`,
    '',
    `Source website: ${sourceWebsiteLink}`,
  ].join('\n');

  return {
    title: article.title,
    message,
    url: appLink,
  };
}
