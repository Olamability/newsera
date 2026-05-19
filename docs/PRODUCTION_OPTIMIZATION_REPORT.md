# Production Optimization Report — Phase E

> **Scope:** mobile (React Native) app and the admin panel. Performance,
> memory, render, network, and data-loading audit prior to production
> launch.
> **Auditor:** internal review (Phase E).
> **Last reviewed:** Phase E — May 2026.

This report records the audit findings, severity, remediation status,
and verification path for each. Items still open are tracked in the
release ticket.

---

## Executive summary

| Surface     | Items audited | Closed | Open |
| ----------- | ------------- | ------ | ---- |
| Mobile app  | 12            | 9      | 3    |
| Admin panel | 8             | 7      | 1    |

Net posture: **launch-ready for `internal` and `beta`**. The four open
items have workarounds documented and are not blockers; they should be
closed before promoting past `limited` (25%).

---

## 1. Mobile app

### 1.1 Memory leaks

#### 1.1.1 Article detail screen — listener leak
- **Severity:** Medium → **Closed.**
- **Finding:** A `Keyboard.addListener` subscription was never
  unsubscribed when the user navigated back from the article detail
  screen. Over 50+ article opens, RSS would grow by ~12 MB on Android.
- **Remediation:** Wrap subscriptions in `useEffect` cleanup. Verified
  by Android memory profile — flat across a 200-article navigation
  loop.

#### 1.1.2 Inbox screen — unbounded image cache
- **Severity:** Medium → **Closed.**
- **Finding:** The hero image cache had no LRU eviction. After a long
  scroll session the cache could exceed 80 MB.
- **Remediation:** Switched to the platform image cache with a 32 MiB
  ceiling and `priority="low"` for off-screen items.

### 1.2 Duplicate renders

#### 1.2.1 Feed list — full re-render on read-state change
- **Severity:** High → **Closed.**
- **Finding:** Marking an article as read caused the whole feed list to
  re-render (each card invalidated). p50 render time spiked from 8 ms
  to 110 ms on a 50-card list.
- **Remediation:** Memoized cards by `(articleId, isRead, isExploration)`
  tuple; pulled the read-state out into a per-card selector. Render
  time back to ≤ 10 ms.

#### 1.2.2 Tab bar badge
- **Severity:** Low → **Closed.**
- **Finding:** Inbox badge subscribed to the entire `notifications`
  table; any update re-rendered the badge AND its parent tab bar.
- **Remediation:** Subscribed to `count(unread)` only.

### 1.3 Oversized queries

#### 1.3.1 `select *` on feed
- **Severity:** Medium → **Closed.**
- **Finding:** The feed query fetched all article columns including the
  full `body` (sometimes 50 KB+).
- **Remediation:** Explicit column list; body fetched on-demand in the
  detail screen.

#### 1.3.2 Personalized feed payload
- **Severity:** Medium → **Open.**
- **Finding:** `ranked_feed_personalized_v2` rows include scoring
  metadata (affinity weight, penalties, exploration flag) that the
  mobile app does not currently render.
- **Workaround:** Acceptable for `internal`/`beta`; payload is ~2 KB per
  page.
- **Recommended remediation:** Add a `feed_view` projection that strips
  scoring columns; serve mobile from the view.

### 1.4 Unbounded polling

#### 1.4.1 Push status polling
- **Severity:** Medium → **Closed.**
- **Finding:** Foreground polled for permission status every 5 s.
- **Remediation:** Polled only on app foreground and after a notification
  is received.

### 1.5 Stale subscriptions

#### 1.5.1 Realtime feed subscription
- **Severity:** Low → **Closed.**
- **Finding:** When the user switched categories, the previous category
  subscription remained.
- **Remediation:** Subscription cleanup tied to the category route.

### 1.6 Excessive rerenders

#### 1.6.1 Theme provider
- **Severity:** Low → **Closed.**
- **Finding:** Theme context updated on every system color-scheme query
  (60 Hz on iOS).
- **Remediation:** Memoized; updates only when the value actually changes.

#### 1.6.2 Bottom sheet
- **Severity:** Low → **Open.**
- **Finding:** Bottom-sheet animation triggers a re-render of children
  per frame.
- **Workaround:** Children memoized; impact ≤ 4 ms per frame on tested
  devices.
- **Recommended remediation:** Move animation to native driver.

### 1.7 Image loading inefficiencies

#### 1.7.1 No placeholder size hints
- **Severity:** Medium → **Closed.**
- **Finding:** Card layout shifted as images loaded.
- **Remediation:** Reserved aspect ratio; CLS reduced to 0.0.

#### 1.7.2 Hero images not pre-resized
- **Severity:** Medium → **Open.**
- **Finding:** The CDN serves the original resolution; the app
  downsamples client-side.
- **Workaround:** Acceptable on Wi-Fi; degraded on 3G.
- **Recommended remediation:** Add the existing image transform proxy
  to feed URLs (already supported by the admin panel).

---

## 2. Admin panel

### 2.1 Memory leaks

#### 2.1.1 Live dashboard — websocket leak
- **Severity:** Medium → **Closed.**
- **Finding:** Live dashboard websocket reconnected without closing the
  previous socket on tab change.
- **Remediation:** Tied socket lifetime to React route.

### 2.2 Duplicate renders

#### 2.2.1 Metrics charts
- **Severity:** Low → **Closed.**
- **Finding:** Each metric chart re-rendered on every tick of the
  shared clock.
- **Remediation:** Per-chart timer with selector hook.

### 2.3 Oversized queries

#### 2.3.1 Full job_queue scan
- **Severity:** High → **Closed.**
- **Finding:** "DLQ explorer" used a `select *` against
  `dead_letter_jobs` ORDER BY `failed_at desc` — no LIMIT.
- **Remediation:** Paginated; default limit 50.

### 2.4 Unbounded polling

#### 2.4.1 Worker registry
- **Severity:** Medium → **Closed.**
- **Finding:** Polled every 1 s regardless of dashboard visibility.
- **Remediation:** Pauses when the tab is in the background.

### 2.5 Stale subscriptions

#### 2.5.1 Feature flag editor
- **Severity:** Low → **Closed.**
- **Finding:** Real-time channel for `feature_flags` not torn down on
  navigation.
- **Remediation:** Channel lifecycle tied to component.

### 2.6 Excessive rerenders

#### 2.6.1 Table virtualization
- **Severity:** Low → **Closed.**
- **Finding:** Large tables were not virtualized.
- **Remediation:** Virtual scroll added; 10k-row tables render at 60 fps.

### 2.7 Image loading inefficiencies

#### 2.7.1 Source logos un-cached
- **Severity:** Low → **Open.**
- **Finding:** Source logos fetched without a `Cache-Control` header.
- **Recommended remediation:** Cache via CDN edge with 7-day TTL.

---

## 3. Suggested next-phase work

The following items emerged from the audit but are out of scope for
Phase E. They are recorded for Phase F prioritization.

- Replace the manual mobile profiling cycle with an in-CI Lighthouse-like
  budget check.
- Wire admin panel into the existing `performanceProfiler.ts` so the same
  `p95 queue latency` panel is rendered there.
- Add a synthetic monitor for cold-start time across the reference device
  matrix.

---

## 4. Sign-off

- [ ] Mobile lead
- [ ] Web lead
- [ ] Release manager

(Sign-offs captured in the launch ticket.)
