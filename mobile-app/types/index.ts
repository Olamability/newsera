export interface Category {
  id: string;
  name: string;
  slug?: string;
}

export interface Source {
  id: string;
  name: string;
  website_url: string | null;
  logo_url: string | null;
  is_verified?: boolean | null;
  promotion_tier?: 'organic' | 'promoted' | null;
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
  is_sponsored?: boolean | null;
  sponsor_name?: string | null;
  campaign_id?: string | null;
  distribution_channel?: 'organic' | 'promoted' | 'sponsored' | null;
  analytics_label?: string | null;
}

export interface Bookmark {
  id: string;
  user_id: string;
  article_id: string;
  created_at: string;
}

export type MainTabParamList = {
  Home: undefined;
  Search: undefined;
  Notifications: undefined;
  Me: undefined;
};

export type RootStackParamList = {
  Splash: undefined;
  Login: undefined;
  Register: undefined;
  ForgotPassword: undefined;
  MainTabs: undefined;
  ArticleDetail: { article: NewsArticle };
  Bookmarks: undefined;
  Settings: undefined;
  CategoryDetail: { categoryId: string; categoryName: string };
  RecentlyViewed: undefined;
  Trending: undefined;
  Widget: undefined;
  Inbox: undefined;
  OfflineReading: undefined;
  ReadLater: undefined;
  BlockedUsers: undefined;
  CountryLanguage: undefined;
  Rewards: undefined;
  Feedback: undefined;
};
