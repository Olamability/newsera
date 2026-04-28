-- ============================================================
-- MIGRATION 010: Article Likes
--
-- Stores per-user likes on articles.
-- user_id is a text field that holds either an authenticated
-- Supabase user UUID or a persistent device ID for guest users.
-- ============================================================

create table if not exists article_likes (
  id         uuid    default gen_random_uuid() primary key,
  article_id uuid    not null references articles(id) on delete cascade,
  user_id    text    not null,
  created_at timestamp default now(),
  unique (article_id, user_id)
);

-- Index for fast per-article like counts
create index if not exists idx_article_likes_article_id
  on article_likes (article_id);
