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

export type AuthRedirectRouteName =
  | 'MainTabs'
  | 'ArticleDetail'
  | 'Bookmarks'
  | 'ReadLater'
  | 'Rewards';

export type AuthRedirectParams = {
  redirectTo?: AuthRedirectRouteName;
  redirectParams?: Record<string, unknown>;
};

export type MainTabParamList = {
  Home: undefined;
  Search: undefined;
  Notifications: undefined;
  Me: undefined;
};

export type RootStackParamList = {
  Splash: undefined;
  Login: AuthRedirectParams | undefined;
  Register: AuthRedirectParams | undefined;
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

// ─── Theme ───────────────────────────────────────────────────────────────────

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppTheme {
  mode: 'light' | 'dark';
  colors: {
    background: string;
    surface: string;
    primary: string;
    text: string;
    textSecondary: string;
    border: string;
    card: string;
    accent: string;
    error: string;
    success: string;
  };
}

// ─── User Preferences ────────────────────────────────────────────────────────

export interface UserPreferences {
  country: string;
  language: string;
  widgetOrder: string[];
  widgetEnabled: Record<string, boolean>;
  dataSaver: boolean;
}

export interface Country {
  code: string;
  name: string;
  flag: string;
}

export interface Language {
  code: string;
  name: string;
  nativeName: string;
}

// ─── Widget ──────────────────────────────────────────────────────────────────

export interface WidgetSection {
  id: string;
  label: string;
  icon: string;
  enabled: boolean;
}

// ─── Feedback ────────────────────────────────────────────────────────────────

export interface FeedbackItem {
  id: string;
  category: 'bug' | 'feature' | 'content' | 'other';
  message: string;
  email?: string;
  status: string;
  created_at: string;
}

// ─── Read Later ───────────────────────────────────────────────────────────────

export interface ReadLaterEntry {
  id: string;
  article: NewsArticle;
  saved_at: string;
}

// ─── Offline ─────────────────────────────────────────────────────────────────

export interface OfflineArticle {
  article: NewsArticle;
  saved_at: string;
  content_snapshot?: string;
}

// ─── Inbox ────────────────────────────────────────────────────────────────────

export interface InboxMessage {
  id: string;
  title: string;
  body: string;
  type: 'system' | 'editorial' | 'reward' | 'breaking' | 'feature';
  read: boolean;
  article_id?: string | null;
  article?: NewsArticle | null;
  created_at: string;
}

// ─── Rewards ─────────────────────────────────────────────────────────────────

export interface UserRewards {
  id: string;
  user_id: string;
  total_points: number;
  current_streak: number;
  longest_streak: number;
  last_active_date?: string | null;
  articles_read: number;
}

export interface RewardEvent {
  id: string;
  event_type: 'read' | 'share' | 'bookmark' | 'streak' | 'milestone';
  points: number;
  description?: string | null;
  created_at: string;
}

// ─── Blocked Users ───────────────────────────────────────────────────────────

export interface BlockedEntry {
  id: string;
  blocked_user_id?: string | null;
  blocked_source_id?: string | null;
  blocked_source?: { id: string; name: string; logo_url?: string | null } | null;
  reason?: string | null;
  created_at: string;
}
