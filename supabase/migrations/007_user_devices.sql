-- ============================================================
-- MIGRATION 007: Device push token storage
-- Stores one Expo push token per device for push notifications.
-- ============================================================

CREATE TABLE user_devices (
    id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    device_id   text        NOT NULL,
    push_token  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_devices_device_id_unique UNIQUE (device_id)
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;

-- Any anonymous client may insert/update its own device row
CREATE POLICY "user_devices_select_all" ON user_devices
    FOR SELECT USING (true);

CREATE POLICY "user_devices_insert_all" ON user_devices
    FOR INSERT WITH CHECK (true);

CREATE POLICY "user_devices_update_all" ON user_devices
    FOR UPDATE USING (true);
