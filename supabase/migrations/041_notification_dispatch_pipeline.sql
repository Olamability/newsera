-- ============================================================
-- MIGRATION 041: Notification dispatch pipeline
-- - notification_events:       raw event intake
-- - notification_deliveries:   per-recipient per-channel delivery tracking
-- - Extend canonical notifications table with type/priority/channel
-- - Rate-limit support + unread counter view
-- - RPCs: enqueue_notification_event, materialize_event_to_notifications,
--         record_notification_delivery, get_unread_counts
-- - Fully additive; existing inbox flow keeps working
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Extend canonical notifications with dispatch metadata
-- ------------------------------------------------------------
ALTER TABLE IF EXISTS notifications
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 5
    CHECK (priority BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'inbox',
  ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS event_id uuid,
  ADD COLUMN IF NOT EXISTS dedup_key text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND conname = 'notifications_type_check'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_type_check
      CHECK (type IN (
        'system', 'editorial', 'reward', 'breaking',
        'feature', 'category_followed', 'engagement',
        'admin_broadcast', 'recommendation'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass
      AND conname = 'notifications_channel_check'
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_channel_check
      CHECK (channel IN ('inbox', 'push', 'realtime', 'email'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedup_unique
  ON notifications (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_type_created
  ON notifications (type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread_user
  ON notifications (user_id, read, created_at DESC)
  WHERE read = false;

-- ------------------------------------------------------------
-- 2) Notification events (raw intake before fanout)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL
    CHECK (event_type IN (
      'breaking_news', 'followed_category', 'engagement_alert',
      'admin_broadcast', 'personalized_recommendation', 'reward', 'editorial'
    )),
  priority smallint NOT NULL DEFAULT 5
    CHECK (priority BETWEEN 1 AND 10),
  article_id uuid REFERENCES articles(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE CASCADE,
  target_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  target_audience text NOT NULL DEFAULT 'all'
    CHECK (target_audience IN ('all', 'category_followers', 'specific_user', 'segment')),
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  channels text[] NOT NULL DEFAULT ARRAY['inbox','push']::text[],
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  delivery_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_events_dedup_pending
  ON notification_events (event_type, dedup_key)
  WHERE dedup_key IS NOT NULL
    AND status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_notification_events_dispatch
  ON notification_events (status, priority DESC, scheduled_for ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notification_events_article
  ON notification_events (article_id);

CREATE INDEX IF NOT EXISTS idx_notification_events_target_user
  ON notification_events (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3) Per-delivery tracking (one row per recipient × channel)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES notification_events(id) ON DELETE CASCADE,
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id text,
  push_token text,
  channel text NOT NULL
    CHECK (channel IN ('inbox', 'push', 'realtime', 'email')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  provider text,
  provider_message_id text,
  error_message text,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event
  ON notification_deliveries (event_id, status);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user_channel
  ON notification_deliveries (user_id, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_pending
  ON notification_deliveries (status, scheduled_for ASC)
  WHERE status = 'pending';

-- ------------------------------------------------------------
-- 4) Rate limiting (per user × type, sliding window)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  notification_type text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_seconds integer NOT NULL DEFAULT 3600
    CHECK (window_seconds BETWEEN 60 AND 86400),
  count integer NOT NULL DEFAULT 0,
  max_per_window integer NOT NULL DEFAULT 10
    CHECK (max_per_window > 0),
  UNIQUE (user_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_notification_rate_limits_user
  ON notification_rate_limits (user_id, notification_type);

CREATE OR REPLACE FUNCTION check_notification_rate_limit(
  p_user_id uuid,
  p_type text,
  p_window_seconds integer DEFAULT 3600,
  p_max_per_window integer DEFAULT 10
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_window_started timestamptz;
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN true; -- broadcast: caller decides
  END IF;

  INSERT INTO notification_rate_limits (
    user_id, notification_type, window_started_at,
    window_seconds, count, max_per_window
  )
  VALUES (p_user_id, p_type, now(), p_window_seconds, 0, p_max_per_window)
  ON CONFLICT (user_id, notification_type) DO NOTHING;

  SELECT window_started_at, count
  INTO v_window_started, v_count
  FROM notification_rate_limits
  WHERE user_id = p_user_id
    AND notification_type = p_type
  FOR UPDATE;

  IF v_window_started < now() - make_interval(secs => p_window_seconds) THEN
    UPDATE notification_rate_limits
    SET window_started_at = now(),
        count = 1,
        window_seconds = p_window_seconds,
        max_per_window = p_max_per_window
    WHERE user_id = p_user_id
      AND notification_type = p_type;
    RETURN true;
  END IF;

  IF v_count >= p_max_per_window THEN
    RETURN false;
  END IF;

  UPDATE notification_rate_limits
  SET count = count + 1
  WHERE user_id = p_user_id
    AND notification_type = p_type;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION check_notification_rate_limit(uuid, text, integer, integer) TO service_role;

-- ------------------------------------------------------------
-- 5) Enqueue helper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_notification_event(
  p_event_type text,
  p_title text,
  p_body text,
  p_target_audience text DEFAULT 'all',
  p_target_user_id uuid DEFAULT NULL,
  p_article_id uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_priority smallint DEFAULT 5,
  p_channels text[] DEFAULT ARRAY['inbox','push']::text[],
  p_dedup_key text DEFAULT NULL,
  p_scheduled_for timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_dedup_key IS NOT NULL THEN
    SELECT id INTO v_id
    FROM notification_events
    WHERE event_type = p_event_type
      AND dedup_key = p_dedup_key
      AND status IN ('pending', 'processing')
    LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO notification_events (
    event_type, priority, article_id, category_id, target_user_id,
    target_audience, title, body, payload, channels, dedup_key,
    scheduled_for
  )
  VALUES (
    p_event_type,
    GREATEST(LEAST(p_priority, 10), 1)::smallint,
    p_article_id, p_category_id, p_target_user_id,
    p_target_audience, p_title, p_body, COALESCE(p_payload, '{}'::jsonb),
    p_channels, p_dedup_key, p_scheduled_for
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION enqueue_notification_event(
  text, text, text, text, uuid, uuid, uuid, jsonb, smallint, text[], text, timestamptz
) TO service_role;

-- ------------------------------------------------------------
-- 6) Materialize event into notifications + delivery rows
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION materialize_notification_event(
  p_event_id uuid,
  p_max_recipients integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_event notification_events%ROWTYPE;
  v_recipient_count integer := 0;
  v_inbox_enabled boolean;
  v_push_enabled boolean;
BEGIN
  SELECT * INTO v_event
  FROM notification_events
  WHERE id = p_event_id
    AND status = 'pending'
  FOR UPDATE;

  IF v_event.id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE notification_events
  SET status = 'processing', updated_at = now()
  WHERE id = p_event_id;

  v_inbox_enabled := 'inbox' = ANY(v_event.channels);
  v_push_enabled  := 'push'  = ANY(v_event.channels);

  -- Build the recipient set in a CTE; cap to avoid runaway fanout.
  WITH recipients AS (
    SELECT u.id AS user_id
    FROM auth.users u
    WHERE
      CASE v_event.target_audience
        WHEN 'specific_user' THEN u.id = v_event.target_user_id
        WHEN 'category_followers' THEN EXISTS (
          SELECT 1
          FROM user_interests ui
          WHERE ui.category_id = v_event.category_id
            AND (
              ui.user_id_uuid = u.id
              OR ui.user_id::text = u.id::text
            )
            AND ui.score > 0
        )
        WHEN 'all' THEN true
        ELSE false
      END
    LIMIT GREATEST(p_max_recipients, 1)
  ),
  inserted_inbox AS (
    INSERT INTO notifications (
      user_id, title, body, article_id, type, priority,
      channel, payload, event_id, dedup_key
    )
    SELECT
      r.user_id,
      v_event.title,
      v_event.body,
      v_event.article_id,
      CASE v_event.event_type
        WHEN 'breaking_news' THEN 'breaking'
        WHEN 'followed_category' THEN 'category_followed'
        WHEN 'engagement_alert' THEN 'engagement'
        WHEN 'admin_broadcast' THEN 'admin_broadcast'
        WHEN 'personalized_recommendation' THEN 'recommendation'
        WHEN 'reward' THEN 'reward'
        WHEN 'editorial' THEN 'editorial'
        ELSE 'system'
      END,
      v_event.priority,
      'inbox',
      v_event.payload,
      v_event.id,
      v_event.dedup_key
    FROM recipients r
    WHERE v_inbox_enabled
    ON CONFLICT (user_id, dedup_key) WHERE dedup_key IS NOT NULL AND user_id IS NOT NULL
    DO NOTHING
    RETURNING id, user_id
  ),
  inbox_deliveries AS (
    INSERT INTO notification_deliveries (
      event_id, notification_id, user_id, channel, status, sent_at
    )
    SELECT v_event.id, i.id, i.user_id, 'inbox', 'delivered', now()
    FROM inserted_inbox i
    RETURNING 1
  ),
  push_deliveries AS (
    INSERT INTO notification_deliveries (
      event_id, user_id, device_id, push_token, channel, status
    )
    SELECT
      v_event.id,
      d.user_id,
      d.device_id,
      d.push_token,
      'push',
      'pending'
    FROM recipients r
    JOIN user_devices d ON d.user_id = r.user_id
    WHERE v_push_enabled
      AND d.push_token IS NOT NULL
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_recipient_count FROM recipients;

  UPDATE notification_events
  SET status = 'completed',
      processed_at = now(),
      recipient_count = v_recipient_count,
      updated_at = now()
  WHERE id = p_event_id;

  RETURN v_recipient_count;
EXCEPTION WHEN OTHERS THEN
  UPDATE notification_events
  SET status = 'failed',
      last_error = SQLERRM,
      processed_at = now(),
      updated_at = now()
  WHERE id = p_event_id;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION materialize_notification_event(uuid, integer) TO service_role;

-- ------------------------------------------------------------
-- 7) Record per-delivery outcome
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_notification_delivery(
  p_delivery_id uuid,
  p_status text,
  p_provider text DEFAULT NULL,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'record_notification_delivery: invalid status %', p_status;
  END IF;

  UPDATE notification_deliveries
  SET status = p_status,
      provider = COALESCE(p_provider, provider),
      provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
      error_message = p_error,
      attempts = attempts + 1,
      sent_at = CASE WHEN p_status IN ('sent','delivered') THEN COALESCE(sent_at, now()) ELSE sent_at END,
      delivered_at = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END,
      updated_at = now()
  WHERE id = p_delivery_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 AND p_status IN ('sent','delivered') THEN
    UPDATE notification_events ne
    SET delivery_count = delivery_count + 1,
        updated_at = now()
    FROM notification_deliveries nd
    WHERE nd.id = p_delivery_id
      AND nd.event_id = ne.id;
  ELSIF v_updated > 0 AND p_status = 'failed' THEN
    UPDATE notification_events ne
    SET failure_count = failure_count + 1,
        updated_at = now()
    FROM notification_deliveries nd
    WHERE nd.id = p_delivery_id
      AND nd.event_id = ne.id;
  END IF;

  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION record_notification_delivery(uuid, text, text, text, text) TO service_role;

-- ------------------------------------------------------------
-- 8) Unread counter helpers
-- NOTE: broadcast notifications (user_id IS NULL) are *also* counted for
-- every user. With the new dispatch pipeline (041), broadcasts are
-- materialized into per-user rows by materialize_notification_event, so
-- user_id IS NULL rows should only exist for legacy/admin direct inserts.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_notification_unread_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COUNT(*)::integer
  FROM notifications
  WHERE (user_id = p_user_id OR user_id IS NULL)
    AND read = false;
$$;

GRANT EXECUTE ON FUNCTION get_notification_unread_count(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 9) updated_at triggers
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'touch_updated_at'
  ) THEN
    CREATE FUNCTION touch_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $body$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_notification_events_touch ON notification_events;
CREATE TRIGGER trg_notification_events_touch
BEFORE UPDATE ON notification_events
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_notification_deliveries_touch ON notification_deliveries;
CREATE TRIGGER trg_notification_deliveries_touch
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 10) RLS
-- ------------------------------------------------------------
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_events_select_admin ON notification_events;
DROP POLICY IF EXISTS notification_events_write_service_role ON notification_events;

CREATE POLICY notification_events_select_admin
  ON notification_events
  FOR SELECT
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY notification_events_write_service_role
  ON notification_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS notification_deliveries_select_own ON notification_deliveries;
DROP POLICY IF EXISTS notification_deliveries_write_service_role ON notification_deliveries;

CREATE POLICY notification_deliveries_select_own
  ON notification_deliveries
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
  );

CREATE POLICY notification_deliveries_write_service_role
  ON notification_deliveries
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS notification_rate_limits_write_service_role ON notification_rate_limits;
CREATE POLICY notification_rate_limits_write_service_role
  ON notification_rate_limits
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
