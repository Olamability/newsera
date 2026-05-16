export declare const SCHEMA_TABLES: readonly [
  'article_click_counts',
  'article_click_counts_alltime',
  'article_clicks',
  'article_comments',
  'article_likes',
  'article_reactions',
  'articles',
  'blocked_users',
  'bookmarks',
  'categories',
  'comments',
  'feedback',
  'inbox_messages',
  'news',
  'notifications',
  'read_later',
  'reward_events',
]

export type SchemaTableName = (typeof SCHEMA_TABLES)[number]
