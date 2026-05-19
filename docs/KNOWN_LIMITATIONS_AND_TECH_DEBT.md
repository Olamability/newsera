# KNOWN LIMITATIONS AND TECHNICAL DEBT

**Purpose:** transparent register of what is *deliberately deferred* past launch. Anything in this document is **accepted** by Engineering leadership at the time of launch authorization. None of it is a launch blocker.

**Update cadence:** monthly during Production Maintenance Mode.

---

## 1. Architecture & topology

### L-1 — Dual workspace-stub / root-source layout
- **What:** `apps/admin-panel`, `apps/mobile-app`, `services/rss-engine` are thin delegators that `corepack pnpm --dir ../../<root>` into the source directories at the repo root (`admin-panel/`, `mobile-app/`, `rss-engine/`).
- **Why kept:** the layout is *intentional* — it preserves `@newsera/*` workspace naming without duplicating code, and changing it would invalidate CI, PM2, and deployment scripts.
- **Cost:** new contributors need a brief orientation.
- **Future:** consolidate to a single canonical location after the platform leaves Maintenance Mode (not before).

### L-2 — Single-instance RSS worker
- **What:** PM2 runs one `rss-engine` instance with `max_memory_restart: 500M`.
- **Why accepted:** auto-restart is fast (<2 s), and the queue runner / notification runner can scale independently. Load tests confirm 4× headroom at launch traffic.
- **Future:** introduce active-passive or sharded ingestion when daily article volume exceeds ~50k/day for two consecutive weeks.

### L-3 — Postgres as the only queue bus
- **What:** `job_queue` uses `SKIP LOCKED` for leasing — no Redis, no Kafka.
- **Why accepted:** intentional design (called out in `queue-runner.ts` comments); validated under 50k-job flood with stable lease latency.
- **Future:** revisit only if sustained throughput exceeds ~30k jobs/min for two consecutive weeks.

---

## 2. Observability

### L-4 — No structured log shipper yet
- **What:** PM2 captures stdout/stderr; long-term archive is a manual periodic sync to object storage.
- **Why accepted:** the Phase G operator dashboard (migration 049) covers the live-incident path. Logs are needed for forensics, not for live alerting.
- **Future:** add a structured shipper (Vector/Fluent Bit → object storage + search index) within the first quarter of Maintenance Mode.

### L-5 — Mobile crash telemetry depends on store-console dashboards
- **What:** we read crash-free sessions from App Store Connect and Play Console rather than from a unified APM.
- **Why accepted:** sufficient for go/no-go decisions; aligns with §1 minimal-dependency posture.
- **Future:** evaluate a unified mobile APM after launch if signals from the two consoles diverge.

---

## 3. Performance & cost

### L-6 — Personalization materialization is hourly
- **What:** `workers/personalization/*` re-materializes personalized feeds hourly.
- **Why accepted:** within p95 budget; cheaper than on-read computation at current scale.
- **Future:** move to event-driven materialization when active-user count justifies the additional infra cost.

### L-7 — Ranking refresh cadence fixed at 15 min
- **What:** `workers/ranking/*` refreshes every 15 min.
- **Why accepted:** matches editorial pace for news; freshness lag is acceptable per product.
- **Future:** allow per-category cadence once we have category-level traffic data.

### L-8 — Cost monitor surfaces totals, not per-tenant attribution
- **What:** Phase G cost panel rolls up DB + storage + push cost daily.
- **Why accepted:** no multi-tenant requirement at launch.
- **Future:** add per-feature attribution alongside any monetization expansion.

---

## 4. Data & retention

### L-9 — `article_clicks` retention is 180 days
- **What:** retention cron prunes click events older than 180 days.
- **Why accepted:** balances cost against analytics utility; product confirmed sufficient.
- **Future:** revisit at first analytics planning cycle.

### L-10 — Materialized trending view is single-region
- **What:** `trending_24h` is a single materialized view refreshed hourly.
- **Why accepted:** users are not yet geo-segmented for trending.
- **Future:** partition by region/locale once we expand localization.

---

## 5. Mobile

### L-11 — Localization is English-only at launch
- **What:** `mobile-app/` ships English; additional locales are staged but not enabled.
- **Why accepted:** scope for v1.0.
- **Future:** enable additional locales in v1.1 once translation QA is complete.

### L-12 — Some screens are placeholder shells
- **What:** `mobile-app/screens/PlaceholderScreen.tsx` is intentionally an empty-state component, used by the navigator where features are deferred.
- **Why accepted:** keeps the navigator stable while features ship behind feature flags or in later releases.
- **Future:** replace each usage as the corresponding feature lands.

---

## 6. Admin panel

### L-13 — Admin panel auth is Supabase email/password only
- **What:** no SSO integration yet.
- **Why accepted:** admin user count is small; passwords meet rotation policy.
- **Future:** add SSO when admin count grows past internal staffing.

### L-14 — Admin actions audited but not yet 4-eyes
- **What:** every admin mutation lands in `admin_audit_log`, but there is no second-approver workflow.
- **Why accepted:** small admin group; audit is sufficient deterrent and forensic trail.
- **Future:** add 4-eyes approval for destructive RPCs when admin group expands.

---

## 7. Database

### L-15 — Migrations are forward-only with safe renames
- **What:** migration 038 chose safe-rename over drop; no destructive DDL on populated tables anywhere in 001–049.
- **Why accepted:** explicit reversibility goal; rollback path is feature-flag flip, not migration revert.
- **Future:** introduce a formal `down` convention only if a true reversible-migration need arises.

### L-16 — `pg_cron` jobs share one Postgres
- **What:** all background cron runs on the same Postgres as user traffic.
- **Why accepted:** cron jobs are throttled and `cron_health_helpers` surface delays; load tests confirmed no contention.
- **Future:** consider a read-replica for heavy materialization if CPU sustained >70%.

---

## 8. Security

### L-17 — Security scanning is CI-typecheck + manual review
- **What:** no automated SAST/DAST in CI today; relying on `npm run typecheck`, `node --check`, manual review, and the SECURITY DEFINER discipline in migrations.
- **Why accepted:** small attack surface (Supabase-managed), and the RLS + SECURITY DEFINER posture is consistently reviewed.
- **Future:** add CodeQL or equivalent SAST to CI in the first Maintenance Mode quarter.

### L-18 — Secrets are managed via `.env` files + EAS secrets
- **What:** no dedicated secret manager.
- **Why accepted:** operationally tractable at current team size; secret-rotation playbook documented.
- **Future:** migrate to a dedicated secret manager when team scales.

---

## 9. Process & docs

### L-19 — Some legacy launch docs overlap with the final set
- **What:** the `docs/` folder contains earlier-phase reports (e.g., `LAUNCH_APPROVAL_REPORT.md`, `FINAL_PRODUCTION_CERTIFICATION.md`) alongside the FINAL_*  set produced for cutover.
- **Why accepted:** historical record; the FINAL_* set is authoritative for go-live per `FINAL_LAUNCH_AUTHORIZATION.md §2`.
- **Future:** consolidate or archive the legacy set after Maintenance Mode transition.

---

## 10. Watchlist (not yet debt, but worth tracking)

| Item | Trigger to act |
|---|---|
| Notification backlog growth | sustained >25k for 24 h |
| `job_queue` table size | >10M rows |
| Daily article volume | >50k/day sustained two weeks |
| Postgres connection saturation | >75% peak two days in a row |
| Mobile bundle size growth | crosses 40 MB (Android) or 60 MB (iOS) |
| Admin user count | exceeds 25 |

---

## 11. Sign-off

This register reflects the **state at launch authorization**. Items will move out of this document as they are addressed, and new items will only be added with Engineering leadership acknowledgement during the monthly Maintenance Mode review.

**Acknowledged by:** Release Engineering Lead, Production Reliability Lead, Engineering leadership.
