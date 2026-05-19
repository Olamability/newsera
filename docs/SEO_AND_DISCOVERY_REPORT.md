# SEO & Discovery Report

Coverage of `workers/seo/*` and `workers/distribution/socialDistributionMonitor.ts`. Surfaced in the Infrastructure → **SEO Health** tab.

## Components

| Module | Responsibility |
|---|---|
| `schemaValidator.ts` | per-article schema.org / OpenGraph / Twitter card validation + duplicate-content clustering |
| `sitemapCoordinator.ts` | per-sitemap freshness vs RPO (news = 5 min, standard = 6 h) |
| `newsIndexingMonitor.ts` | indexing drift, news velocity, source authority |
| `seoHealthAuditor.ts` | composes the above into a single 0..1 score and surfaces top issues |
| `socialDistributionMonitor.ts` | per-channel publish health, share velocity, CTR/attribution anomalies |

## Readiness state

| Surface | State |
|---|---|
| News sitemap freshness SLA | 5 minutes |
| Standard sitemap freshness SLA | 6 hours |
| Schema validation | run on every published article |
| Indexing observers wired | `google_news`, `bing_news`, `sitemap_ping` (Apple News optional) |
| Duplicate-content detector | scans last 7d of publications |
| Source authority floor | 0.5 (unknown) |
| Social channels monitored | twitter, facebook, linkedin, reddit, rss, newsletter |

## Known risks

* If Google News fails to crawl, `driftScore` falls slowly because the SLA is 30 min — pages with high news velocity may already have lost the trending window before we alert. **Mitigation:** include `sitemap_ping` as a faster signal.
* `sourceAuthority` defaults to 0.5 for unknown hosts; brand-new partner sources should be backfilled with manual authority scores during onboarding.
* Duplicate-content clustering uses simple title+description fingerprinting; aggressive paraphrasing won't be caught. **Mitigation:** the editorial pipeline retains independent semantic-similarity checks (Phase E).

## Mitigations

* `seoHealthAuditor` penalises duplicate-content clusters at 0.02 per cluster (cap 0.4) so a sudden duplication storm visibly tanks the SEO score.
* Sitemap freshness scoring is squared-decay: a sitemap twice its SLA scores 0.
* Drift score is `1 - drifted/published`; one drifted article in 1000 still scores 0.999.

## Rollback strategy

All SEO modules are pure compute. The dashboard tab is a viewer. There is no auto-rollback path for SEO regressions — operators investigate via the tab and the editorial pipeline.

## Operational checklist

- [ ] News sitemap rebuilt every ≤ 5 min
- [ ] Standard sitemap rebuilt every ≤ 6 h
- [ ] `schemaValidator` returns `ok=true` on > 99% of published articles
- [ ] Indexing drift score ≥ 0.9
- [ ] Duplicate-content clusters ≤ 5 per 24h
- [ ] Source authority registered for top 50 partner hosts
- [ ] Social channel health: all `successRate ≥ 0.9`, no `failing` channels

## Signoff

| Role | Name | Status |
|---|---|---|
| Growth lead |   | ☐ |
| Content lead |   | ☐ |
| Platform eng |   | ☐ |
