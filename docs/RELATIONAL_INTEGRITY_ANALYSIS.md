# Relational Integrity Analysis and FK Reconstruction

## Scope
- mobile-app Supabase access layer (`services/*`, `screens/*`)
- admin-panel query layer (`src/pages/*`)
- rss-engine ingestion path (`src/fetchSources.js`, `src/saveArticles.js`)
- existing migrations and live schema snapshot (`supabase/database-schema-snapshot.json`)

## 1) Relationship Graph (runtime-validated)
| Source column | Target PK | On delete | Nullability | Evidence |
|---|---|---|---|---|
| `articles.source_id` | `sources.id` | `SET NULL` | nullable | runtime selects and rss ingestion |
| `articles.category_id` | `categories.id` | `SET NULL` | nullable | runtime selects and category filters |
| `sources.category_id` | `categories.id` | `SET NULL` | nullable | admin and rss category join |
| `bookmarks.user_id` | `auth.users.id` | `CASCADE` | non-null | bookmark ownership |
| `bookmarks.article_id` | `articles.id` | `CASCADE` | non-null | bookmark article join |
| `read_later.user_id` | `auth.users.id` | `CASCADE` | nullable | read later ownership |
| `read_later.article_id` | `articles.id` | `CASCADE` | non-null | read later article join |
| `article_comments.article_id` | `articles.id` | `CASCADE` | non-null | comment article join |
| `article_comments.user_id` | `auth.users.id` | `CASCADE` | non-null | comment author join |
| `article_comments.parent_id` | `article_comments.id` | `CASCADE` | nullable | threaded comment parent |
| `article_reactions.article_id` | `articles.id` | `CASCADE` | non-null | reaction article join |
| `article_reactions.user_id` | `auth.users.id` | `CASCADE` | non-null | reaction user join |
| `article_likes.article_id` | `articles.id` | `CASCADE` | nullable | legacy like article join |
| `article_likes.user_id_uuid` | `auth.users.id` | `CASCADE` | nullable | staged legacy like user join |
| `article_clicks.article_id` | `articles.id` | `CASCADE` | nullable | click article join |
| `article_clicks.source_id` | `sources.id` | `SET NULL` | nullable | click source join |
| `article_clicks.user_id` | `auth.users.id` | `SET NULL` | nullable | click user join |
| `article_clicks_partitioned.article_id` | `articles.id` | `CASCADE` | non-null | partitioned click article join |
| `article_clicks_partitioned.source_id` | `sources.id` | `SET NULL` | nullable | partitioned click source join |
| `article_clicks_partitioned.user_id` | `auth.users.id` | `SET NULL` | nullable | partitioned click user join |
| `blocked_users.user_id` | `auth.users.id` | `CASCADE` | non-null | blocked entries owner |
| `blocked_users.blocked_user_id` | `auth.users.id` | `SET NULL` | nullable | blocked user reference |
| `blocked_users.blocked_source_id` | `sources.id` | `CASCADE` | nullable | blocked source reference |
| `feedback.user_id` | `auth.users.id` | `SET NULL` | nullable | optional feedback author |
| `inbox_messages.user_id` | `auth.users.id` | `SET NULL` | nullable | targeted inbox messages |
| `inbox_messages.article_id` | `articles.id` | `SET NULL` | nullable | message article reference |
| `notifications.user_id` | `auth.users.id` | `SET NULL` | nullable | notification recipient |
| `notifications.article_id` | `articles.id` | `SET NULL` | nullable | notification article reference |
| `user_devices.user_id` | `auth.users.id` | `CASCADE` | nullable | device registration owner |
| `user_preferences.user_id` | `auth.users.id` | `CASCADE` | non-null | preferences owner |
| `user_rewards.user_id` | `auth.users.id` | `CASCADE` | non-null | rewards owner |
| `reward_events.user_id` | `auth.users.id` | `CASCADE` | non-null | reward event owner |
| `user_read_history.user_id` | `auth.users.id` | `CASCADE` | non-null | read history owner |
| `user_read_history.article_id` | `articles.id` | `CASCADE` | non-null | read history article |
| `user_interests.category_id` | `categories.id` | `CASCADE` | non-null | interest category reference |
| `user_interests.user_id_uuid` | `auth.users.id` | `CASCADE` | nullable | staged interest user reference |
| `content_flags.reporter_user_id` | `auth.users.id` | `SET NULL` | nullable | flag reporter reference |
| `content_flags.reviewed_by` | `auth.users.id` | `SET NULL` | nullable | flag reviewer reference |
| `content_flags.article_id` | `articles.id` | `CASCADE` | nullable | flagged article reference |
| `content_flags.comment_id` | `article_comments.id` | `CASCADE` | nullable | flagged comment reference |
| `content_flags.source_id` | `sources.id` | `CASCADE` | nullable | flagged source reference |
| `article_shares.article_id` | `articles.id` | `CASCADE` | non-null | share article reference |
| `article_shares.user_id` | `auth.users.id` | `SET NULL` | nullable | share user reference |
| `article_tags.article_id` | `articles.id` | `CASCADE` | non-null | tagged article reference |
| `article_tags.tag_id` | `tags.id` | `CASCADE` | non-null | tag reference |
| `rss_feed_sources.source_id` | `sources.id` | `SET NULL` | nullable | feed source reference |
| `rss_ingestion_log.feed_id` | `rss_feed_sources.id` | `SET NULL` | nullable | ingestion feed reference |
| `ingestion_jobs.feed_id` | `rss_feed_sources.id` | `CASCADE` | non-null | ingestion job feed reference |
| `ingestion_jobs.source_id` | `sources.id` | `SET NULL` | nullable | ingestion job source reference |
| `admin_audit_log.admin_user_id` | `auth.users.id` | `CASCADE` | non-null | admin actor reference |

## 2) Validation Findings
### Valid relationship candidates
- All reconstructed relationships use UUID→UUID key pairs except staged legacy compatibility columns (`article_likes.user_id_uuid`, `user_interests.user_id_uuid`) which are already UUID.
- FK support indexes already exist for most high-traffic joins (articles/source/category, comments/article, reactions/article, bookmarks).

### Invalid or incompatible structures discovered
- `article_likes.user_id` is `text` (legacy) and cannot safely receive a direct FK to `auth.users(id)`.
- `user_interests.user_id` is `text` (legacy/device-compatible) and cannot safely receive a direct FK to `auth.users(id)`.
- Both tables require staged UUID companion columns (`*_user_id_uuid`) for relational enforcement.

### Missing constraints addressed by migration
- Added/standardized FK coverage for all runtime-critical ownership and join paths in app/admin/rss code paths.
- Added FK coverage for platform tables that affect moderation, ingestion, rewards, personalization, and analytics safety.

### Orphan risks and cleanup strategy
- Nullable FK columns: automatic orphan repair by setting invalid references to `NULL` before validation.
- Non-null FK columns: no destructive cleanup is performed; constraints are created `NOT VALID` and validated only if no orphans exist.
- All deferred validations are recorded in `public.relational_integrity_audit` for operational follow-up.

### Duplicate integrity risks
- Existing duplicate unique indexes remain in some tables (`articles.url`, `sources.rss_url`) and are out-of-scope for destructive cleanup.
- Composite uniqueness for interaction tables remains preserved (`bookmarks`, `article_reactions`, `article_tags`, `user_read_history`).

## 3) SAFE Additive Migration Strategy Implemented
1. Add/ensure FK-supporting indexes (additive only).
2. Backfill/repair nullable orphan references (`SET NULL` only).
3. Add FK constraints as `NOT VALID` to avoid unsafe production lock failures.
4. Validate each FK only when orphan count is zero.
5. Persist validation/defer decisions in `relational_integrity_audit`.
6. Leave legacy text columns in place for backward compatibility.

## 4) Integrity Improvements
- Reconstructed full runtime FK architecture for core product domains.
- Enforced forward integrity on writes even when historical orphan rows exist.
- Added deterministic audit trail for unresolved legacy data quality debt.

## 5) Remaining Risks
- Historical orphan rows on non-null relationship columns can still block full FK validation and need manual remediation.
- Legacy text identity columns (`article_likes.user_id`, `user_interests.user_id`) remain transitional.
- Polymorphic audit references (`admin_audit_log.entity_id`) remain intentionally unconstrained.

## 6) Production Readiness Score
- Relational integrity: **8.5/10**
- Scalability: **8/10**
- Maintainability: **8/10**
- Query safety: **9/10**
- Migration safety: **9/10**

Overall: **8.5/10 (production-ready with managed legacy cleanup backlog).**
