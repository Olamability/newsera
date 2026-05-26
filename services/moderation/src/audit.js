/**
 * Append a row to admin_activity_log within the supplied pg transaction client.
 *
 * The DB-side trigger computes prev_hash and row_hash. We supply everything
 * else. Callers MUST use the same `client` that performed the business write,
 * so the audit entry shares the transaction and is atomic with the change.
 */
export async function logAdminActivity(client, entry) {
  const {
    requestId,
    actorId,
    actorRole,
    action,
    targetType,
    targetId,
    before = null,
    after = null,
    reasonCode = null,
    reasonText = null,
    metadata = {},
  } = entry;

  if (!action) throw new Error('logAdminActivity: action is required');

  await client.query(
    `insert into public.admin_activity_log
       (request_id, actor_id, actor_role, action, target_type, target_id,
        before_state, after_state, reason_code, reason_text, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      requestId ?? null,
      actorId ?? null,
      actorRole ?? null,
      action,
      targetType ?? null,
      targetId != null ? String(targetId) : null,
      before,
      after,
      reasonCode,
      reasonText,
      metadata,
    ],
  );
}
