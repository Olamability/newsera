Executive Summary
System is not production-ready in its current state. Core user flows exist, but there are major risks in schema consistency, admin operability, security posture (notably push-token exposure), migration drift, and reliability under scale. The monorepo structure is also split between “real apps” and wrapper packages, which increases operational confusion.

1) Architecture Overview
Text architecture diagram
Mobile App (Expo RN)
→ uses Supabase anon/auth clients
→ reads/writes tables (articles, bookmarks, article_comments, article_reactions, etc.)
→ realtime on likes/comments/reactions/trending/headlines
→ local storage for offline/read-later/notifications/recent history

Admin Panel (React + Vite)
→ uses Supabase anon client + auth session
→ manages sources/categories, reads analytics views

RSS Engine (Node)
→ uses Supabase service_role client
→ fetches active RSS sources
→ parses feeds + images
→ upserts articles
→ logs to rss_ingestion_log
→ calls refresh_trending_feed()

Supabase (Postgres + RLS + migrations)
→ main data plane for all services
→ heavy migration history with overlapping comment/trending/reaction logic

Entry points
Mobile: /home/runner/work/newsera/newsera/mobile-app/App.tsx
Admin: /home/runner/work/newsera/newsera/admin-panel/src/main.jsx → App.jsx
RSS engine runtime logic: /home/runner/work/newsera/newsera/rss-engine/worker.js and index.js
PM2 production entry: /home/runner/work/newsera/newsera/services/rss-engine/index.js
DB migrations: /home/runner/work/newsera/newsera/supabase/migrations/*.sql
Dependency relationships
Mobile/admin depend on Supabase JS with anon key.
RSS engine depends on Supabase JS with service-role key.
Root workspace scripts route to wrapper packages (apps/*, services/*) which proxy into top-level app folders (mobile-app, admin-panel, rss-engine).
2) Supabase Integration Audit
Supabase clients found
mobile-app/services/supabase.ts
supabasePublic (anon, no persisted session)
supabaseAuth (anon + persisted auth session)
alias supabase = supabaseAuth
admin-panel/src/lib/supabaseClient.ts
single anon client
rss-engine/config/supabase.js
service-role client
Total createClient instances: 4

Risk assessment (duplication/misuse)
Mobile dual-client pattern is intentional but increases accidental misuse risk.
Admin and mobile have separate auth implementations; no shared auth module.
RSS engine uses service-role correctly on server-side only.
Logging code in RSS (rss_ingestion_log payload fallback strategy) strongly indicates schema drift and runtime mismatch handling.
Auth flow consistency
Mobile: robust session restore + auth state listener.
Admin: client-side admin gating via session.user.app_metadata.role === 'admin'.
Backend enforcement for admin mutations is not in repo migrations (sources/categories only have public SELECT policy), so admin write operations are likely blocked unless manual DB policies exist outside repo.
3) Database + Migration State
Schema health
~21 tables created across migrations.
High migration churn in article_comments, article_likes, trending feed view/materialized view, and bookmarks legacy fixes.
Multiple overlapping “fix” migrations indicate historical inconsistency.
Broken/conflicting/high-risk areas
article_comments: created/altered repeatedly (011, 024, 025, 026, 027, 031), including destructive conversion removing non-UUID user_id rows.
comments table exists (012) but app uses article_comments; likely orphan/legacy duplicate.
article_reactions created in 028 and guarded again in 032.
Trending feed object churn: regular view (025) → materialized view (029) → dropped/rebuilt (031) + concurrent refresh fn (032).
rss_feed_sources appears unused by runtime ingestion code; likely orphan.
RLS mismatch hotspots:
user_devices has open read/insert/update policies (USING true) => unsafe.
sources/categories write policies absent in migrations (admin CRUD risk).
Spec/doc mismatch: docs mention approved; schema/runtime use active.
4) RSS Engine State
Pipeline map
sources(status=active)
→ fetch RSS (retry + timeout + URL validation)
→ normalize content/image
→ dedupe in-memory by URL
→ upsert articles on unique url
→ log run to rss_ingestion_log
→ refresh trending materialized view

Bottlenecks / risks
OG-image lookup per article can trigger large external HTTP volume.
Upsert uses count: 'exact' (extra DB overhead).
Logging uses multiple payload schemas fallback; indicates unstable schema contract.
Scheduler (setInterval) skips if prior run still active; can silently miss cycles under load.
No queueing/dead-letter/backpressure strategy.
Crash/hanging risks
Hard crashes prevented in many places; failures mostly logged and swallowed.
Ingestion won’t stop on log errors (good), but observability quality is degraded.
Scalability rating
4/10 (works for small/moderate volume; weak for high-source/high-item scale).
5) Mobile App State (React Native)
UX stability
Navigation structure is coherent.
Home/Trending/Category feeds use pagination guards and virtualization tuning.
Comments UI has optimistic updates + realtime hooks + threaded rendering.
Broken/fragile flows
Inbox backend policy allows broadcast (user_id is null) but client query filters .eq('user_id', user.id) only; broadcast messages won’t appear.
Reward event recording does multi-step writes without transaction and weak error handling (can desync points/events).
Comment count can drift if realtime insert event is missed (optimistic add doesn’t directly increment persisted count path).
Splash always routes to MainTabs (intentional “public first”), but auth-gated paths rely on later redirects.
Performance bottlenecks
Heavy ArticleDetail screen with multiple parallel network calls + realtime + nested FlatLists.
Pull-to-refresh on Home prefetches multiple feeds (extra network load).
Trending realtime updates can trigger multiple patch fetches.
6) Admin Panel State
Security risk report
Admin gate is client-side role check from JWT claim.
Safe only if DB RLS policies are strict; repo migrations do not include admin write RLS for sources/categories.
README suggests permissive policy examples (auth.role() = 'authenticated'), which would be unsafe in production if applied broadly.
Architecture inconsistency report
Monorepo uses wrapper packages (apps/admin-panel) pointing to top-level app folder (admin-panel).
CI runs top-level folders directly, not workspace wrappers.
Typecheck is declared, but codebase is mostly JSX/JS; TypeScript checks are limited in practical coverage.
CRUD safety
Current code performs direct client-side CRUD against Supabase.
Without carefully designed RLS, this is either blocked (likely now) or dangerously open (if permissive policies added manually).
7) Top 10 Performance Bottlenecks (ranked)
ArticleDetail click tracking path: select recent click + insert + rpc per click (multi-roundtrip).
RSS OG image fetching for many feed items.
Trending realtime patching with per-article fetch batches.
Home pull-refresh prefetches multiple feeds every refresh.
Materialized trending refresh cadence may contend with ingestion + reads.
count: exact in repeated queries/upserts (DB cost).
Comment/thread processing on client for large threads.
Search fallback path may run second full-text query on missing column case.
Analytics enrichment pattern (counts query + secondary lookup joins in app layer).
Missing composite sort indexes for some user timelines (inbox_messages, reward_events, etc.).
8) Security Audit
HIGH
user_devices RLS policies allow broad read/write; push tokens are sensitive and should not be globally readable/updatable.
Admin writes depend on policy setup; if permissive authenticated-write policy is used, privilege boundary is weak.
MEDIUM
RSS/admin URL validation blocks obvious private hosts but does not fully mitigate DNS-rebinding/private-resolution edge cases.
Security-definer functions and broad public RPC access need tighter review/least privilege checks.
LOW
Dev logs include operational details (tokens/errors payloads in dev paths).
Local notification/event storage may expose data on compromised device (expected client risk).
9) Reliability & Bug Risk Report
Migration drift and repeated “fix” migrations are the biggest long-term reliability risk.
Rewards update flow is non-transactional and can silently diverge.
RSS logging schema mismatch workaround implies fragile observability.
Realtime-heavy screens are robustly guarded in many places, but event-loss can produce stale counters/state.
No meaningful automated test suite; CI is mostly type/syntax/build checks.
10) Final System Score
Architecture: 5/10
Stability: 4/10
Performance: 5/10
Security: 3/10
Production readiness: 4/10
Final Verdict
NOT READY

Critical issues (must-fix-first)
Lock down user_devices RLS immediately.
Define/standardize admin mutation authorization model (strict RLS, not UI-only).
Resolve migration/schema drift around comments/reactions/trending/logging.
Fix RSS ingestion log schema contract (single canonical payload).
Add transactional/atomic strategy for rewards write path.
Hidden risks (non-obvious)
Wrapper-package vs real-folder split can cause deploy/CI/operator mistakes.
Orphan/legacy tables (comments, rss_feed_sources) increase accidental wrong-table usage.
Broadcast inbox policy exists but app query excludes broadcasts (feature appears “working” but incomplete).
Recommended fix order (priority roadmap)
Security hardening (RLS + admin auth model).
Schema cleanup + migration reconciliation.
RSS logging/ingestion contract stabilization.
Reliability fixes for rewards/comments counters/realtime fallbacks.
Performance tuning (ArticleDetail, trending realtime strategy, RSS fetch cost).
