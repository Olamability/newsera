-- RSS feed source registry
create table if not exists rss_feed_sources (
  id              uuid        primary key default gen_random_uuid(),
  name            text        not null,
  url             text        not null unique,
  category        text,
  country         text        default 'NG',
  language        text        default 'en',
  is_active       boolean     not null default true,
  last_fetched_at timestamptz,
  last_error      text,
  fetch_count     integer     not null default 0,
  error_count     integer     not null default 0,
  created_at      timestamptz not null default now()
);

-- Per-run ingestion audit log
create table if not exists rss_ingestion_log (
  id                uuid        primary key default gen_random_uuid(),
  feed_id           uuid        references rss_feed_sources(id) on delete cascade,
  feed_url          text        not null,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  articles_found    integer     default 0,
  articles_saved    integer     default 0,
  articles_skipped  integer     default 0,
  error             text,
  status            text        not null default 'running'
                      check (status in ('running','success','error'))
);

create index if not exists idx_rss_ingestion_log_feed_id
  on rss_ingestion_log (feed_id);

create index if not exists idx_rss_ingestion_log_started_at
  on rss_ingestion_log (started_at desc);
