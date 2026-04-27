-- ============================================================
-- MIGRATION 008: Atomic user-interest increment function
-- Provides a stored function to atomically insert or increment
-- the interest score for a (user_id, category_id) pair,
-- eliminating the select-then-update race condition.
-- ============================================================

CREATE OR REPLACE FUNCTION increment_user_interest(
    p_user_id     text,
    p_category_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO user_interests (user_id, category_id, score, updated_at)
    VALUES (p_user_id, p_category_id, 1, now())
    ON CONFLICT (user_id, category_id)
    DO UPDATE SET
        score      = user_interests.score + 1,
        updated_at = now();
END;
$$;
