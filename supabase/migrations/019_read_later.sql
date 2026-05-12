create table if not exists read_later (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references auth.users(id) on delete cascade,
  article_id uuid        not null references articles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, article_id)
);

create index if not exists idx_read_later_user_id
  on read_later (user_id);

alter table read_later enable row level security;

create policy "Users manage read_later"
  on read_later
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
