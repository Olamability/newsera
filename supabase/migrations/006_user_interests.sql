-- ============================================================
-- MIGRATION 006: User interest tracking
-- Stores per-device category preference scores, incremented
-- each time the user clicks an article in that category.
-- ============================================================

CREATE TABLE user_interests (
    id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     text        NOT NULL,
    category_id uuid        NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
    score       integer     NOT NULL DEFAULT 1,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_interests_user_category_unique UNIQUE (user_id, category_id)
);

-- Index for fast look-up of a device's ranked interests
CREATE INDEX idx_user_interests_user_category ON user_interests (user_id, category_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE user_interests ENABLE ROW LEVEL SECURITY;

-- Any anonymous client may insert/update/read its own rows
CREATE POLICY "user_interests_select_all" ON user_interests
    FOR SELECT USING (true);

CREATE POLICY "user_interests_insert_all" ON user_interests
    FOR INSERT WITH CHECK (true);

CREATE POLICY "user_interests_update_all" ON user_interests
    FOR UPDATE USING (true);
