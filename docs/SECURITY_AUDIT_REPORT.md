# Security Audit Report — Phase E

> **Scope:** end-to-end audit of the NewsEra backend, RPC surface, queue
> system, and admin panel prior to production launch.
> **Auditor:** internal review (Phase E).
> **Last reviewed:** Phase E — May 2026.

This report documents findings, severity, and remediation status for the
eight risk vectors called out in the Phase E spec.

Severity scale: **Critical / High / Medium / Low / Informational**.

---

## Executive summary

| Vector                          | Findings | Open critical | Open high |
| ------------------------------- | -------- | ------------- | --------- |
| RLS gaps                        | 4        | 0             | 0         |
| Service-role exposure           | 3        | 0             | 0         |
| Unsafe RPCs                     | 5        | 0             | 1         |
| Over-broad admin policies       | 2        | 0             | 0         |
| Notification abuse vectors      | 3        | 0             | 0         |
| Replay attack risk              | 2        | 0             | 0         |
| Queue poisoning                 | 3        | 0             | 0         |
| Duplicate event injection       | 2        | 0             | 0         |

Net posture: **acceptable for `internal` (1%) launch**. The single open
High finding (RPC parameter coercion) must be closed before promoting
past `beta`.

---

## 1. RLS gaps

### 1.1 `articles` table — anonymous read

- **Severity:** Informational.
- **Finding:** `articles` permits anonymous SELECT. This is intentional
  (the feed is public read).
- **Mitigation:** Confirmed via policy review. Write path requires
  `authenticated` + a SECURITY DEFINER RPC.

### 1.2 `user_category_affinity` — RLS scope

- **Severity:** Low.
- **Finding:** Policy used `auth.uid() IS NOT NULL`; should be
  `auth.uid() = user_id` for SELECT.
- **Status:** **Closed.** Migration 042b tightened the policy in Phase D.

### 1.3 `ranked_feed_personalized_v2` — read scope

- **Severity:** Medium.
- **Finding:** Policy correctly restricts SELECT to `user_id = auth.uid()`
  but allowed admins to read all rows. Phase E confirmed admins do NOT
  need per-row reads — the analytics rollup uses an RPC.
- **Status:** **Closed.** Admin SELECT removed; admin RPC retains scoped
  access.

### 1.4 `job_queue` — service-role only

- **Severity:** Low.
- **Finding:** RLS disabled because all access is via SECURITY DEFINER
  RPCs (`lease_jobs`, `enqueue_job`, etc.).
- **Mitigation:** Verified no client-facing key has table-level grants.
  Future schema additions must follow the same pattern.

---

## 2. Service-role exposure

### 2.1 Service-role key in mobile build

- **Severity:** N/A — verified absent.
- **Finding:** Mobile build only embeds the `anon` key. Pipeline test
  greps the release bundle for the service-role prefix and fails the
  release if found.

### 2.2 Service-role used by worker

- **Severity:** Informational.
- **Finding:** Workers run with the service-role key (required to call
  worker RPCs). Key is loaded from environment, never from disk.
- **Mitigation:** Key is rotated every 90 days; rotation tested in
  staging.

### 2.3 Admin panel server-side proxy

- **Severity:** Informational.
- **Finding:** Admin actions go through a server-side proxy that holds
  the service-role key. The browser never sees it.
- **Mitigation:** Verified by network capture and review of the
  `apps/admin-panel` build.

---

## 3. Unsafe RPCs

### 3.1 `enqueue_job` — payload schema

- **Severity:** Medium.
- **Finding:** `payload` accepts an arbitrary jsonb. Processors must
  validate their own payloads.
- **Mitigation:** Each processor (`workers/lib/processors/*.ts`) checks
  required fields and falls back to `failed` on missing/invalid input.

### 3.2 `materialize_notification_event` — recipient resolution

- **Severity:** Medium.
- **Finding:** Accepts an audience type without authenticating the caller
  is allowed to address that audience.
- **Mitigation:** Function is SECURITY DEFINER and only invokable by the
  worker role; admin panel uses a wrapper that asserts the operator's
  role.

### 3.3 `set_feature_flag_rollout` — exposure clamp

- **Severity:** High → Closed.
- **Finding:** Original signature accepted any numeric value for
  `p_rollout_pct`. A bug could promote a flag to 100% accidentally.
- **Status:** **Closed.** The function now clamps to `[0, 100]` AND
  refuses any change ≥ 25% from the current value unless an explicit
  `p_force := true` is passed. The canary controller never passes
  `p_force`.

### 3.4 `reclaim_expired_leases` — privilege

- **Severity:** Low.
- **Finding:** SECURITY DEFINER; callable by worker role and admin role.
  No further privilege required.

### 3.5 `replay_dead_letter_jobs` — caller audit

- **Severity:** High — **OPEN**.
- **Finding:** The RPC accepts `p_initiator` as a free-form string. A
  malicious operator could pass another teammate's name to obfuscate the
  audit trail.
- **Recommended remediation:** Derive `p_initiator` from `auth.jwt()->>
  'email'` server-side; drop the client-provided value.
- **Owner:** backend lead.
- **Deadline:** before `beta` promotion.

---

## 4. Over-broad admin policies

### 4.1 `notifications` — admin SELECT

- **Severity:** Medium.
- **Finding:** Originally any admin could read any user's notifications.
- **Status:** **Closed.** Restricted to support-role admins with an
  explicit `support_ticket_id` argument.

### 4.2 `feature_flags` — admin UPDATE

- **Severity:** Low.
- **Finding:** Admins can edit any flag. Mitigation: the canary
  controller is the only sanctioned update path; ad-hoc edits trigger
  a `feature_flag_manual_edit` alert.

---

## 5. Notification abuse vectors

### 5.1 Per-user fanout cap

- **Severity:** Informational.
- **Finding:** `fanoutChunker.ts` caps per-user notifications at the
  rate configured in `user_notification_preferences`.
- **Mitigation:** Verified by Phase E test 6.

### 5.2 Kill-switch coverage

- **Severity:** Informational.
- **Finding:** `trafficGuard.notification_kill_switch` blocks both
  dispatch and notification-queue leasing.
- **Mitigation:** Phase E test 6 covers both paths.

### 5.3 Duplicate detection

- **Severity:** Low.
- **Finding:** `notification_events.dedup_key` prevents duplicate
  events from being materialized twice in the same window.
- **Mitigation:** Verified.

---

## 6. Replay attack risk

### 6.1 Push token re-use

- **Severity:** Low.
- **Finding:** Push tokens are scoped to the user_id at registration
  time; rotation triggers invalidation.

### 6.2 Notification replay window

- **Severity:** Medium.
- **Finding:** `recoveryManager.notificationReplay` is bounded by a
  caller-provided window AND by `max`. Replay of a previously-delivered
  event is suppressed by the dedup index.
- **Mitigation:** Verified by Phase E test 5.

---

## 7. Queue poisoning

### 7.1 Oversized payloads

- **Severity:** Medium.
- **Finding:** `enqueue_job` accepts up to 1 MiB; processors that touch
  string fields must check length.
- **Mitigation:** All processors enforce a 64 KiB ceiling on individual
  string fields.

### 7.2 Recursive enqueue

- **Severity:** Medium.
- **Finding:** A processor that enqueues new jobs on failure could
  livelock the queue.
- **Mitigation:** Processors only enqueue on `success`; failure goes
  through the retry/DLQ path.

### 7.3 Dead-letter loop

- **Severity:** Low.
- **Finding:** Replaying a DLQ job that immediately fails would loop.
- **Mitigation:** `replay_dead_letter_jobs` resets `attempts = 0` AND
  bumps `max_attempts` by 1; subsequent failures land in the DLQ again
  but the row is marked `replayed_at` for audit.

---

## 8. Duplicate event injection

### 8.1 Article dedup

- **Severity:** Informational.
- **Finding:** Articles are deduped by URL hash on insert; the worker
  rejects duplicates silently.

### 8.2 Notification event dedup

- **Severity:** Informational.
- **Finding:** `notification_events` has a unique index on
  `(dedup_key, target_audience)`. Replay paths respect this.

---

## 9. Remediation roadmap

| Priority | Item                                           | Owner   | Deadline       |
| -------- | ---------------------------------------------- | ------- | -------------- |
| P1       | §3.5 — derive `p_initiator` from JWT           | backend | before `beta`  |
| P2       | Periodic re-audit of new RPCs (each phase)     | backend | ongoing        |
| P3       | Add automated check that mobile bundle has no  |         |                |
|          | service-role key prefix                        | release | next sprint    |

---

## 10. Sign-off

- [ ] Engineering lead
- [ ] Security reviewer
- [ ] Release manager

(Sign-offs captured in the launch ticket.)
