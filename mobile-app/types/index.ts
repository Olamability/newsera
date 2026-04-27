export interface Category {
  id: string;
  name: string;
  slug: string;
}

export interface Source {
  id: string;
  name: string;
  website_url: string | null;
  logo_url: string | null;
}

export interface NewsArticle {
  id: string;
  title: string;
  content: string | null;
  snippet: string | null;
  image_url: string | null;
  published_at: string | null;
  url: string;
  source_id: string | null;
  category_id: string | null;
  sources: Source | null;
  categories: Category | null;
}

export type RootStackParamList = {
  Home: undefined;
  ArticleDetail: { article: NewsArticle };
};
