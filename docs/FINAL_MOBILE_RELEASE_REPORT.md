# Final Mobile Release Report

_Phase F — App Store launch hardening. This report is the mobile owner's checklist for the production release of the NewsEra mobile app. It must be signed off before `backend_notification_dispatch` is promoted to `global` and before the build is submitted to the App Store / Play Store._

---

## 1. Build context

- Repository: `apps/mobile-app` (and `mobile-app/` workspace).
- Release branch: tag the launch commit `vX.Y.Z` per `RELEASE_WORKFLOW.md`.
- Backend dependency: Phase F rollout must be at stage ≥ 3 (`personalization_v1` STABLE) before the App Store build is submitted, so the launched binary can rely on the personalisation backend.

---

## 2. Production readiness checklist

Each item must be verified on a release-mode build for both iOS and Android. The mobile owner records the result in the rightmost column.

### 2.1 Performance

- [ ] **Startup speed** — cold start to first paint < 2 s on a baseline device (Pixel 6a / iPhone 12). Warm start < 800 ms.
- [ ] **Scroll performance** — feed list maintains 60 FPS scrolling 100 items with images loaded.
- [ ] **Memory stability** — 30-minute idle session keeps RSS within ±15% of post-warm-up baseline (no leak).
- [ ] **Image caching** — second view of the same article reads from cache (no network call); cache eviction does not exceed configured budget.

### 2.2 Reliability

- [ ] **Crash-free sessions** ≥ 99.5% in the latest beta cohort week.
- [ ] **Offline handling** — feed shows last cached content with a `stale` banner; pull-to-refresh fails gracefully without crashing.
- [ ] **Deep links** — `newsera://article/:id` and `https://newsera.app/article/:id` both open the correct screen in cold and warm starts.

### 2.3 Notifications

- [ ] **Permission UX** — first-launch prompt explains value; deferred prompt path exists for users who dismiss.
- [ ] **Token registration** — `user_devices.push_token` populated within 5 s of permission grant.
- [ ] **Test send** — admin dashboard "Notification test sender" delivers within 30 s to a logged-in device.
- [ ] **Daily ceiling** — multiple test sends in quick succession are throttled by the backend (`safety/userProtection.canSendNotification`), with no client-side bypass.

### 2.4 Analytics

- [ ] **Events fire** — `app_open`, `feed_view`, `article_click`, `article_read`, `bookmark`, `share`, `notification_open` all appear in the analytics pipeline within one minute of action.
- [ ] **No PII leakage** — analytics payloads contain no email, push token, or auth header.
- [ ] **Sampling sanity** — 1 000 simulated `feed_view` events produce ≥ 950 rows in `analytics_events` (no silent drops).

### 2.5 Security

- [ ] **Secrets** — no `SUPABASE_SERVICE_ROLE_KEY` or admin RPC reference present in the shipped JS bundle.
- [ ] **Cert pinning** — TLS connections to the API host use the expected certificate chain (no MITM via local trust store).
- [ ] **Storage** — auth token stored in the OS secure store (Keychain / EncryptedSharedPreferences), not in `AsyncStorage`.

---

## 3. Backend coupling

Before promoting the mobile build:

1. `rolloutManager.snapshot()` shows `personalization_v1` in `STABLE`.
2. `notification_kill_switch` in `trafficGuard.state()` is `false`.
3. `userProtector` daily ceiling is configured to the launch value (default 25 / day).
4. `feedQualityAuditor` returns score ≥ 0.85 on a sampled feed.

---

## 4. Store submission

### iOS

- [ ] App Store Connect — privacy nutrition labels filled (notifications, identifiers, usage data).
- [ ] App Store Connect — encryption export declaration submitted.
- [ ] TestFlight build approved by ≥ 2 internal reviewers.
- [ ] Screenshots updated for the current feed UI.
- [ ] What's New copy reviewed.

### Android

- [ ] Play Console — Data Safety form filled.
- [ ] Internal testing track build promoted to closed testing.
- [ ] Target API level meets the current Play requirement.
- [ ] Screenshots updated for the current feed UI.

---

## 5. Post-launch monitoring

For the first 7 days after public availability:

- [ ] Crash-free sessions dashboard checked daily; alert at < 99%.
- [ ] `incidentDetector` snapshot reviewed each shift; any CRITICAL pauses the rollout.
- [ ] `userProtector.snapshot(<sample userIds>)` audited weekly to confirm cooldowns engaging.
- [ ] App Store / Play Store reviews scanned for crash or notification complaints; correlate with backend incidents.

---

## 6. Sign-off

| Role | Name | Date | Status |
| ---- | ---- | ---- | ------ |
| Mobile owner       |  |  | _pending_ |
| Backend owner      |  |  | _pending_ |
| Security reviewer  |  |  | _pending_ |
| Launch coordinator |  |  | _pending_ |

The mobile build may be submitted to the App Store / Play Store only after every checklist item above is checked and every sign-off row is signed.
