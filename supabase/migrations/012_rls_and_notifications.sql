-- ============================================================
-- MIGRATION 012: RLS, Notifications table, and article_likes upgrade
--
-- Creates:
--   • comments        — auth-bound comments (user_id uuid → auth.users)
--   • notifications   — per-user notification store
--
-- Alters:
--   • article_likes   — adds device_id column for guest support;
--                        adds partial unique indexes for user & device;
--                        upgrades the existing plain unique constraint
--                        to the new split partial-index strategy.
--
-- Enables Row Level Security on all three tables and installs
-- the minimal read / write policies required by the mobile app.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. COMMENTS
--    Separate from the existing article_comments table (which
--    uses a text user_id for guest support). This table is
--    auth-only and references auth.users directly.
-- ────────────────────────────────────────────────────────────

create table if not exists comments (
  id         uuid        primary key default gen_random_uuid(),
  article_id uuid        not null references articles(id) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  content    text        not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_comments_article_id
  on comments (article_id);

create index if not exists idx_comments_user_id
  on comments (user_id);


-- ────────────────────────────────────────────────────────────
-- 2. ARTICLE_LIKES  — upgrade existing table
--    Migration 010 created article_likes(user_id text not null).
--    We add a nullable device_id column and partial unique
--    indexes so that authenticated users and guest devices are
--    deduplicated independently.
-- ────────────────────────────────────────────────────────────

-- Add device_id column if it does not already exist
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'article_likes' and column_name = 'device_id'
  ) then
    alter table article_likes add column device_id text;
  end if;
end $$;

-- Partial unique index: one like per authenticated user per article
create unique index if not exists unique_like_per_user
  on article_likes (article_id, user_id)
  where user_id is not null;

-- Partial unique index: one like per guest device per article
create unique index if not exists unique_like_per_device
  on article_likes (article_id, device_id)
  where device_id is not null;


-- ────────────────────────────────────────────────────────────
-- 3. NOTIFICATIONS
--    Server-side notification store. The mobile app also caches
--    notifications locally via AsyncStorage; this table enables
--    cross-device delivery in a future push-server integration.
-- ────────────────────────────────────────────────────────────

create table if not exists notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references auth.users(id) on delete cascade,
  title      text,
  body       text,
  article_id uuid        references articles(id) on delete set null,
  read       boolean     not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_id
  on notifications (user_id);

create index if not exists idx_notifications_article_id
  on notifications (article_id);


-- ════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ════════════════════════════════════════════════════════════

-- ── comments ────────────────────────────────────────────────

alter table comments enable row level security;

-- Anyone (including anonymous) can read comments
create policy "Allow read comments"
  on comments
  for select
  using (true);

-- Only the authenticated user who owns the row may insert
create policy "Allow insert comments"
  on comments
  for insert
  with check (auth.uid() = user_id);

-- Only the owner may delete their own comment
create policy "Allow delete own comment"
  on comments
  for delete
  using (auth.uid() = user_id);


-- ── article_likes ────────────────────────────────────────────

alter table article_likes enable row level security;

-- Anyone can read like counts
create policy "Allow read article_likes"
  on article_likes
  for select
  using (true);

-- Authenticated users may insert a like for themselves
create policy "Allow insert like (auth)"
  on article_likes
  for insert
  with check (
    auth.uid() is not null
    and user_id = auth.uid()::text
  );

-- Guest users may insert a like using only device_id
create policy "Allow insert like (guest)"
  on article_likes
  for insert
  with check (
    auth.uid() is null
    and device_id is not null
    and user_id is not null   -- device_id stored in user_id for guests
  );

-- Users may remove their own like
create policy "Allow delete own like"
  on article_likes
  for delete
  using (user_id = coalesce(auth.uid()::text, device_id));


-- ── notifications ────────────────────────────────────────────

alter table notifications enable row level security;

-- Users can only see their own notifications
create policy "Allow read own notifications"
  on notifications
  for select
  using (auth.uid() = user_id);

-- Server-side inserts use the service role (bypasses RLS).
-- If client-side inserts are needed, enable this policy:
-- create policy "Allow insert notifications"
--   on notifications
--   for insert
--   with check (auth.uid() = user_id);

-- Users can mark their own notifications as read
create policy "Allow update own notifications"
  on notifications
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Users can delete their own notifications
create policy "Allow delete own notifications"
  on notifications
  for delete
  using (auth.uid() = user_id);
