create table if not exists user_preferences (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  country        text        not null default 'NG',
  language       text        not null default 'en',
  widget_order   jsonb       not null default '["headlines","trending","politics","sports","entertainment","tech"]',
  widget_enabled jsonb       not null default '{"headlines":true,"trending":true,"politics":true,"sports":true,"entertainment":true,"tech":true}',
  data_saver     boolean     not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id)
);

alter table user_preferences enable row level security;

create policy "Users manage own preferences"
  on user_preferences
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
