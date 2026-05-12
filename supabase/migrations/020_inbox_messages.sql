create table if not exists inbox_messages (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references auth.users(id) on delete cascade,
  title      text        not null,
  body       text        not null,
  type       text        not null default 'system'
               check (type in ('system','editorial','reward','breaking','feature')),
  read       boolean     not null default false,
  article_id uuid        references articles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_inbox_messages_user_id
  on inbox_messages (user_id);

alter table inbox_messages enable row level security;

-- Users see their own messages; null user_id = broadcast (visible to all auth users)
create policy "Users read own messages"
  on inbox_messages
  for select
  using (auth.uid() = user_id or user_id is null);

create policy "Users update own messages"
  on inbox_messages
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete own messages"
  on inbox_messages
  for delete
  using (auth.uid() = user_id);
