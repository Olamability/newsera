create table if not exists blocked_users (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  blocked_user_id   uuid        references auth.users(id) on delete cascade,
  blocked_source_id uuid        references sources(id) on delete cascade,
  reason            text,
  created_at        timestamptz not null default now(),
  unique (user_id, blocked_user_id),
  unique (user_id, blocked_source_id)
);

create index if not exists idx_blocked_users_user_id
  on blocked_users (user_id);

alter table blocked_users enable row level security;

create policy "Users manage own blocked"
  on blocked_users
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
