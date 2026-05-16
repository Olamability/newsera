-- ============================================================
-- MIGRATION 033: Security hardening for admin writes + device tokens
-- ============================================================

-- 1) Admin write authorization (sources/categories)
ALTER TABLE IF EXISTS sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sources_admin_write ON sources;
CREATE POLICY sources_admin_write
  ON sources
  FOR ALL
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  WITH CHECK (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

DROP POLICY IF EXISTS categories_admin_write ON categories;
CREATE POLICY categories_admin_write
  ON categories
  FOR ALL
  TO authenticated
  USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin')
  WITH CHECK (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin');

-- 2) user_devices push-token security hardening
ALTER TABLE IF EXISTS user_devices
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id ON user_devices (user_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_devices_device_id_unique'
      AND conrelid = 'user_devices'::regclass
  ) THEN
    ALTER TABLE user_devices DROP CONSTRAINT user_devices_device_id_unique;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_devices_user_id_device_id_unique'
      AND conrelid = 'user_devices'::regclass
  ) THEN
    ALTER TABLE user_devices
      ADD CONSTRAINT user_devices_user_id_device_id_unique UNIQUE (user_id, device_id);
  END IF;
END $$;

DROP POLICY IF EXISTS "user_devices_select_all" ON user_devices;
DROP POLICY IF EXISTS "user_devices_insert_all" ON user_devices;
DROP POLICY IF EXISTS "user_devices_update_all" ON user_devices;
DROP POLICY IF EXISTS user_devices_select_own ON user_devices;
DROP POLICY IF EXISTS user_devices_insert_own ON user_devices;
DROP POLICY IF EXISTS user_devices_update_own ON user_devices;
DROP POLICY IF EXISTS user_devices_delete_own ON user_devices;

CREATE POLICY user_devices_select_own
  ON user_devices
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY user_devices_insert_own
  ON user_devices
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_devices_update_own
  ON user_devices
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_devices_delete_own
  ON user_devices
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
