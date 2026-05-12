create table if not exists feedback (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references auth.users(id) on delete set null,
  category   text        not null check (category in ('bug','feature','content','other')),
  message    text        not null,
  email      text,
  status     text        not null default 'open',
  created_at timestamptz not null default now()
);

alter table feedback enable row level security;

create policy "Allow insert feedback"
  on feedback
  for insert
  with check (true);

create policy "Users read own feedback"
  on feedback
  for select
  using (auth.uid() = user_id);
