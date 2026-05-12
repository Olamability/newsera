create table if not exists user_rewards (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references auth.users(id) on delete cascade,
  total_points     integer     not null default 0,
  current_streak   integer     not null default 0,
  longest_streak   integer     not null default 0,
  last_active_date date,
  articles_read    integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id)
);

create table if not exists reward_events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  event_type  text        not null
                check (event_type in ('read','share','bookmark','streak','milestone')),
  points      integer     not null default 0,
  description text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_reward_events_user_id
  on reward_events (user_id);

alter table user_rewards enable row level security;

create policy "Users manage own rewards"
  on user_rewards
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter table reward_events enable row level security;

create policy "Users read own reward events"
  on reward_events
  for select
  using (auth.uid() = user_id);

create policy "Users insert own reward events"
  on reward_events
  for insert
  with check (auth.uid() = user_id);
