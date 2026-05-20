-- ============================================================
-- MIGRATION 050: Fix admin_update_feature_flag signature
--
-- Purely additive, surgical fix for the operational defect where
-- feature-flag mutations could not be performed via the canonical
-- RPC path, forcing operators to attempt raw `UPDATE feature_flags`
-- which then failed against the RLS policy with:
--   "must be owner of table feature_flags"
--
-- Root cause
-- ----------
-- Migration 047 defined:
--     admin_update_feature_flag(text, boolean, smallint, text)
--
-- PostgreSQL's function-overload resolution does NOT implicitly
-- cast `integer` -> `smallint`. As a result:
--   * The documented call pattern
--       SELECT admin_update_feature_flag(
--         'queue_based_ingestion', true, 100, 'reason');
--     fails with "function admin_update_feature_flag(text, boolean,
--     integer, text) does not exist" because the literal `100` is
--     typed as `integer`.
--   * supabase-js / PostgREST RPC calls that send JSON numbers
--     (e.g. the admin panel's `updateFeatureFlag` helper) hit the
--     same dispatch failure.
--
-- Fix
-- ----
-- Replace the parameter type with `integer` and clamp to a valid
-- smallint range (0..100) inside the function body. Behaviour is
-- otherwise identical:
--   * SECURITY DEFINER
--   * `_is_admin_caller()` enforced
--   * audited via `_log_admin_action`
--   * returns boolean success
--   * `is_feature_enabled` / `is_feature_enabled_for_user` unchanged
--
-- The RLS policies on `feature_flags` are intentionally NOT relaxed:
-- this RPC remains the only supported mutation path. Direct
-- `UPDATE feature_flags ...` from application code is unsupported.
-- ============================================================

SET ROLE postgres;

-- ------------------------------------------------------------
-- 1) Drop the old smallint-typed signatures.
--
-- `admin_emergency_disable_feature_flag` calls
-- `admin_update_feature_flag` from its body. Function bodies are
-- not tracked as DDL dependencies, so dropping the underlying
-- function does not require CASCADE; we drop it explicitly first
-- so the recreation below is unambiguous.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS admin_emergency_disable_feature_flag(text, text);
DROP FUNCTION IF EXISTS admin_update_feature_flag(text, boolean, smallint, text);

-- ------------------------------------------------------------
-- 2) Canonical feature-flag mutation RPC.
--
-- p_rollout_percent is `integer` so the function is dispatchable
-- from psql literals and JSON-typed RPC clients. The value is
-- clamped to [0, 100] and stored as smallint to match the
-- underlying column type and existing CHECK constraint.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION admin_update_feature_flag(
  p_name text,
  p_enabled boolean,
  p_rollout_percent integer DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_prev_enabled boolean;
  v_prev_rollout smallint;
  v_new_rollout smallint;
  v_updated integer;
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_update_feature_flag: forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT enabled, rollout_percent
  INTO v_prev_enabled, v_prev_rollout
  FROM feature_flags
  WHERE name = p_name
  FOR UPDATE;

  IF v_prev_enabled IS NULL THEN
    RAISE EXCEPTION 'admin_update_feature_flag: unknown flag %', p_name;
  END IF;

  -- Clamp to the smallint domain enforced by the feature_flags CHECK.
  v_new_rollout := GREATEST(0, LEAST(100,
    COALESCE(p_rollout_percent, v_prev_rollout::integer)))::smallint;

  UPDATE feature_flags
  SET enabled = p_enabled,
      rollout_percent = v_new_rollout
  WHERE name = p_name;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  PERFORM _log_admin_action(
    'update_feature_flag', 'feature_flags', NULL, p_reason,
    jsonb_build_object(
      'name', p_name,
      'prev_enabled', v_prev_enabled,
      'prev_rollout_percent', v_prev_rollout,
      'new_enabled', p_enabled,
      'new_rollout_percent', v_new_rollout
    )
  );

  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_feature_flag(text, boolean, integer, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION admin_update_feature_flag(text, boolean, integer, text) IS
  'Canonical (and ONLY supported) mutation path for public.feature_flags. '
  'SECURITY DEFINER, admin-gated, audited. Application code must not issue '
  'direct UPDATE statements against feature_flags — RLS will reject them '
  'with "must be owner of table feature_flags" and bypassing the RPC would '
  'also skip the admin audit log.';

-- ------------------------------------------------------------
-- 3) Recreate the emergency kill-switch on top of the new signature.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION admin_emergency_disable_feature_flag(
  p_name text,
  p_reason text DEFAULT 'emergency_disable'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT _is_admin_caller() THEN
    RAISE EXCEPTION 'admin_emergency_disable_feature_flag: forbidden'
      USING ERRCODE = '42501';
  END IF;

  RETURN admin_update_feature_flag(p_name, false, 0, p_reason);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_emergency_disable_feature_flag(text, text)
  TO authenticated, service_role;

RESET ROLE;
