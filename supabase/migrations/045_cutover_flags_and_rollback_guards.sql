-- ============================================================
-- MIGRATION 045: Cutover feature flags & rollback guards
-- - feature_flags table for gating new pipelines
-- - is_feature_enabled(name) helper RPC
-- - Seeds flags for each new subsystem (default OFF) so legacy paths
--   continue to operate until each pipeline is explicitly enabled
-- - Provides a clean, reversible cutover/rollback surface
-- ============================================================

SET ROLE postgres;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- 1) Feature flag store
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
  name text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent smallint NOT NULL DEFAULT 0
    CHECK (rollout_percent BETWEEN 0 AND 100),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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

DROP TRIGGER IF EXISTS trg_feature_flags_touch ON feature_flags;
CREATE TRIGGER trg_feature_flags_touch
BEFORE UPDATE ON feature_flags
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 2) Helper RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_feature_enabled(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COALESCE(
    (SELECT enabled FROM feature_flags WHERE name = p_name),
    false
  );
$$;

GRANT EXECUTE ON FUNCTION is_feature_enabled(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION is_feature_enabled_for_user(p_name text, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_enabled boolean;
  v_rollout smallint;
  v_bucket integer;
BEGIN
  SELECT enabled, rollout_percent
  INTO v_enabled, v_rollout
  FROM feature_flags
  WHERE name = p_name;

  IF v_enabled IS NULL OR v_enabled IS FALSE THEN
    RETURN false;
  END IF;

  IF v_rollout >= 100 OR p_user_id IS NULL THEN
    RETURN true;
  END IF;

  -- Deterministic bucket: first 8 hex chars of uuid -> 0..99
  v_bucket := (
    ('x' || substr(replace(p_user_id::text, '-', ''), 1, 8))::bit(32)::int
  ) % 100;
  IF v_bucket < 0 THEN
    v_bucket := v_bucket + 100;
  END IF;

  RETURN v_bucket < v_rollout;
END;
$$;

GRANT EXECUTE ON FUNCTION is_feature_enabled_for_user(text, uuid)
  TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3) Seed canonical flags (default OFF for safe staged cutover)
-- ------------------------------------------------------------
INSERT INTO feature_flags (name, enabled, rollout_percent, description) VALUES
  ('queue_based_ingestion',       false, 0,
   'Switch RSS ingestion from interval worker to job_queue/lease_due_feeds pipeline.'),
  ('backend_notification_dispatch', false, 0,
   'Use notification_events + materialize_notification_event for dispatch (vs local-only push).'),
  ('personalization_v1',          false, 0,
   'Use user_category_affinity/user_source_affinity for personalized feed ranking.'),
  ('ranking_v1',                  false, 0,
   'Serve feeds from ranked_feed_global / ranked_feed_category / ranked_feed_personalized.'),
  ('breaking_feed_v1',            false, 0,
   'Surface ranked_feed_breaking in the mobile breaking-news rail.'),
  ('worker_heartbeats_required',  false, 0,
   'Block lease acquisition for workers without recent heartbeats (operational guard).')
ON CONFLICT (name) DO NOTHING;

-- ------------------------------------------------------------
-- 4) RLS
-- ------------------------------------------------------------
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS feature_flags_select_all ON feature_flags;
DROP POLICY IF EXISTS feature_flags_write_admin ON feature_flags;
DROP POLICY IF EXISTS feature_flags_write_service_role ON feature_flags;

-- Flags are non-sensitive; clients may read to gate UI affordances.
CREATE POLICY feature_flags_select_all
  ON feature_flags
  FOR SELECT
  USING (true);

CREATE POLICY feature_flags_write_admin
  ON feature_flags
  FOR ALL
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  WITH CHECK (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

CREATE POLICY feature_flags_write_service_role
  ON feature_flags
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

RESET ROLE;
