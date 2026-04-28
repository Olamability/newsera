-- ============================================================
-- MIGRATION 011: Article Comments
--
-- Stores flat (non-threaded) comments on articles.
-- user_id is a text field that holds either an authenticated
-- Supabase user UUID or a persistent device ID for guest users.
-- ============================================================

create table if not exists article_comments (
  id         uuid    default gen_random_uuid() primary key,
  article_id uuid    not null references articles(id) on delete cascade,
  user_id    text    not null,
  content    text    not null,
  created_at timestamp default now()
);

-- Index for fast per-article comment retrieval
create index if not exists idx_article_comments_article_id
  on article_comments (article_id);
