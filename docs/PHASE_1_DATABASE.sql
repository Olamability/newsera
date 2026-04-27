Complete SQL schema for a news aggregator platform using Supabase (PostgreSQL).

Tables required:

1. categories
- id (uuid primary key, default uuid_generate_v4())
- name (text, unique, not null)
- slug (text, unique, not null)

2. sources
- id (uuid primary key)
- name (text)
- website_url (text)
- rss_url (text)
- logo_url (text)
- category (text)
- status (text default 'pending')
- created_at (timestamp default now())

3. news
- id (uuid primary key)
- title (text)
- content (text)
- snippet (text)
- source (text)
- image_url (text)
- published_at (timestamp)
- url (text unique)
- category (text)

4. bookmarks
- id (uuid primary key)
- user_id (uuid references auth.users)
- news_id (uuid references news.id)
- created_at (timestamp default now())

Requirements:
- Add constraints and indexes
- Ensure referential integrity
- Optimize for querying news by category and date
