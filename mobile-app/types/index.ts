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
  // Mapped fields populated after fetch
  source_name?: string | null;
  category_name?: string | null;
  like_count?: number | null;
  comment_count?: number | null;
}

export interface Bookmark {
  id: string;
  user_id: string;
  article_id: string;
  created_at: string;
}

export type RootStackParamList = {
  Splash: undefined;
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
  Home: undefined;
  ArticleDetail: { article: NewsArticle };
  Bookmarks: undefined;
  Profile: undefined;
};
