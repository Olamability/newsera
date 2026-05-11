import * as ExpoLinking from 'expo-linking';
import { ShareContent } from 'react-native';
import { NewsArticle } from '../types';

const APP_NAME = 'Newsera';

export function resolveArticleSourceName(article: NewsArticle): string {
  return article.source_name ?? article.sources?.name ?? 'Unknown Source';
}

export function getArticleAppLink(articleId: string): string {
  return ExpoLinking.createURL(`article/${articleId}`);
}

export function buildArticleShareContent(article: NewsArticle): ShareContent {
  const sourceName = resolveArticleSourceName(article);
  const appLink = getArticleAppLink(article.id);

  const message = [
    `Read this story on ${APP_NAME} 📰`,
    `Source: ${sourceName}`,
    '',
    article.title,
    '',
    appLink,
  ].join('\n');

  return {
    title: article.title,
    message,
    url: appLink,
  };
}
