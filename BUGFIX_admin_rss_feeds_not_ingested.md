# Bug Fix: Admin-Created RSS Feeds Not Being Ingested

## Problem Statement
Admin-created RSS feeds in `rss_feed_sources` are NOT being ingested in real-time by the RSS ingestion workers. Seeded/system feeds work correctly.

## Root Cause Analysis (CONFIRMED — migration 062 applied)

**The dual-table gap**: The admin panel writes to `sources` only.
The RSS ingestion worker (`rss-worker.ts`) reads exclusively from
`rss_feed_sources` via `lease_due_feeds()`. No sync existed between
the two tables, so admin-created/approved feeds were permanently
invisible to the worker.

Seeded feeds work because migrations 051/056/060 write directly into
`rss_feed_sources` with `is_active=true` and `next_fetch_at=now()`.

**Fix applied**: Migration `062_bridge_admin_sources_to_rss_feeds.sql`
- Trigger `trg_sync_source_to_rss_feeds` — auto-syncs on approval
- RPC `admin_activate_rss_feed()` — atomic approve + feed activation
- Backfill — all existing active sources synced to `rss_feed_sources`
- Admin panel `Sources.jsx` updated to call the RPC on Approve

3. The `lease_due_feeds()` function (migration 040) SHOULD pick up these feeds because:
   - The eligibility check is: `f.is_active = true AND f.next_fetch_at <= now() AND NOT EXISTS (active lease)`
   - New feeds with no `ingestion_jobs` row pass the `NOT EXISTS` check
   - The function then creates the `ingestion_jobs` row via `INSERT ... ON CONFLICT`

## The Actual Bug

The bug is likely one of these scenarios:

### Scenario 1: `next_fetch_at` is NULL or Future Date
When admin panel creates feeds, if `next_fetch_at` is NULL or set to a future date, the feed won't be eligible:

```sql
AND f.next_fetch_at <= now()  -- This filters out NULL or future dates
```

**Check the admin panel feed creation code** - it may not be setting `next_fetch_at` correctly.

### Scenario 2: `is_active` Default Value Issue
The feed might be created with `is_active=false` by default.

### Scenario 3: Missing Backfill of Existing Feeds
If feeds were created before the worker was deployed, they might have stale `next_fetch_at` values.

## Solution

### Fix 1: Database-Level Default for `next_fetch_at`

Ensure the column default is set correctly in migration 040:

```sql
ADD COLUMN IF NOT EXISTS next_fetch_at timestamptz NOT NULL DEFAULT now()
```

This is already correct in migration 040, line 28.

### Fix 2: Admin Panel Feed Creation

**Check the admin panel code** that creates RSS feeds. Ensure it sets:
- `is_active` = `true`
- `next_fetch_at` = `now()` (or let the database default handle it)

Look for code in `admin-panel/` that inserts into `rss_feed_sources`.

### Fix 3: Backfill Existing Admin-Created Feeds

Create a migration to fix any existing feeds with NULL or future `next_fetch_at`:

```sql
-- Fix existing admin-created feeds with bad next_fetch_at values
UPDATE rss_feed_sources
SET next_fetch_at = now()
WHERE is_active = true
  AND (
    next_fetch_at IS NULL 
    OR next_fetch_at > now() + interval '1 hour'
  );
```

### Fix 4: Add Database Trigger (Optional but Recommended)

Create a trigger to ensure `next_fetch_at` is always set when a new feed is created:

```sql
CREATE OR REPLACE FUNCTION ensure_rss_feed_next_fetch()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.next_fetch_at IS NULL OR NEW.next_fetch_at > now() + interval '1 day' THEN
    NEW.next_fetch_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rss_feed_sources_ensure_next_fetch
BEFORE INSERT ON rss_feed_sources
FOR EACH ROW
EXECUTE FUNCTION ensure_rss_feed_next_fetch();
```

## Verification Steps

1. **Check existing feeds**:
   ```sql
   SELECT id, name, url, is_active, next_fetch_at, 
          CASE 
            WHEN next_fetch_at IS NULL THEN 'NULL next_fetch_at'
            WHEN next_fetch_at > now() THEN 'Future next_fetch_at'
            WHEN NOT is_active THEN 'Inactive'
            ELSE 'Should be eligible'
          END AS status
   FROM rss_feed_sources
   WHERE source_id IS NOT NULL -- admin-created typically have source_id
     AND url NOT LIKE '%bbc%' AND url NOT LIKE '%reuters%' -- exclude seeded
   ORDER BY created_at DESC;
   ```

2. **Check eligibility**:
   ```sql
   SELECT COUNT(*) as eligible_feeds
   FROM rss_feed_sources f
   WHERE f.is_active = true
     AND f.next_fetch_at <= now()
     AND NOT EXISTS (
       SELECT 1
       FROM ingestion_jobs ij
       WHERE ij.feed_id = f.id
         AND ij.leased_until IS NOT NULL
         AND ij.leased_until > now()
     );
   ```

3. **Check ingestion_jobs status**:
   ```sql
   SELECT 
     f.id, f.name, f.next_fetch_at, f.is_active,
     ij.last_status, ij.leased_until, ij.last_run_at
   FROM rss_feed_sources f
   LEFT JOIN ingestion_jobs ij ON ij.feed_id = f.id
   WHERE f.url NOT LIKE '%bbc%' AND f.url NOT LIKE '%reuters%'
   ORDER BY f.created_at DESC
   LIMIT 10;
   ```

4. **Check worker logs** for `lease_due_feeds_idle` messages with eligibility counts.

## Immediate Workaround

For existing broken feeds, run:

```sql
UPDATE rss_feed_sources
SET next_fetch_at = now(),
    is_active = true,
    backoff_seconds = 0,
    consecutive_failures = 0,
    last_error = NULL
WHERE is_active = true
  AND (next_fetch_at IS NULL OR next_fetch_at > now() + interval '1 hour');
```

## Files to Check

1. **Admin Panel Feed Creation**:
   - Look for files in `admin-panel/src/` that handle RSS feed creation
   - Search for `rss_feed_sources` INSERT operations
   - Verify `next_fetch_at` is being set

2. **Worker Logs**:
   - Check `rss-worker.ts` logs for `lease_due_feeds_idle` events
   - Look for `eligible_feeds` count in the logs

3. **Database**:
   - Run the verification queries above
   - Check if `next_fetch_at` has NULL values for admin-created feeds

## Next Steps

1. Run the verification SQL queries
2. Check admin panel code for feed creation logic
3. Apply the backfill UPDATE if needed
4. Consider adding the database trigger for future-proofing
5. Monitor worker logs after fixes are applied
