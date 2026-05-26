import { withTransaction } from './db.js';
import { logAdminActivity } from './audit.js';
import { ACTIONS, actionById } from './actions.js';
import { loadAdminPermissions, primaryRole, requirePermission } from './permissions.js';
import { computeSeverity, slaDueAt } from './triage.js';

export { computeSeverity, slaDueAt };

/**
 * Intake a new report. Dedupes against open reports for same target;
 * links into the existing moderation_case when present.
 *
 * Atomic: report row + (optional case row) + admin_activity_log in one txn.
 */
export async function intakeReport(input, { requestId } = {}) {
  const { reporterId, targetType, targetId, reasonCode, description } = input;
  if (!targetType || !targetId || !reasonCode) {
    const err = new Error('reporterId, targetType, targetId, reasonCode are required');
    err.statusCode = 400;
    throw err;
  }

  return withTransaction(async (client) => {
    // Pull existing risk score (if any)
    const riskRes = await client.query(
      `select score from public.risk_scores where subject_type=$1 and subject_id=$2`,
      [targetType, String(targetId)],
    );
    const riskScore = Number(riskRes.rows[0]?.score ?? 0);
    const severity = computeSeverity(reasonCode, riskScore);
    const due = slaDueAt(severity);

    // Find or create the case for this target
    const caseRes = await client.query(
      `select id from public.moderation_cases
        where target_type=$1 and target_id=$2 and status in ('open','in_review')
        order by opened_at desc limit 1`,
      [targetType, String(targetId)],
    );
    let caseId;
    if (caseRes.rows[0]) {
      caseId = caseRes.rows[0].id;
      // Escalate case severity if this report is more severe
      await client.query(
        `update public.moderation_cases
            set severity = greatest(severity, $2)
          where id = $1`,
        [caseId, severity],
      );
    } else {
      const ins = await client.query(
        `insert into public.moderation_cases (target_type, target_id, severity)
           values ($1,$2,$3) returning id`,
        [targetType, String(targetId), severity],
      );
      caseId = ins.rows[0].id;
    }

    const reportRes = await client.query(
      `insert into public.reports
         (reporter_id, target_type, target_id, reason_code, description,
          severity, sla_due_at, case_id, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'triaged')
       returning *`,
      [
        reporterId ?? null,
        targetType,
        String(targetId),
        reasonCode,
        description ?? null,
        severity,
        due.toISOString(),
        caseId,
      ],
    );
    const report = reportRes.rows[0];

    await logAdminActivity(client, {
      requestId,
      actorId: reporterId ?? null,
      actorRole: 'reporter',
      action: 'report.intake',
      targetType: 'report',
      targetId: report.id,
      after: report,
      reasonCode,
      metadata: { caseId, severity, sla_due_at: due.toISOString() },
    });

    return { report, caseId };
  });
}

/**
 * Apply a moderation action. Centralised so every action follows the same
 * pattern: permission check → business write → moderation_actions →
 * admin_activity_log, all in one transaction.
 */
export async function applyAction({ actorId, actionId, target, payload = {}, requestId }) {
  if (!actorId) {
    const err = new Error('actorId required');
    err.statusCode = 401;
    throw err;
  }
  const action = actionById(actionId);
  if (!action) {
    const err = new Error(`Unknown action: ${actionId}`);
    err.statusCode = 400;
    throw err;
  }
  if (!payload.reasonCode) {
    const err = new Error('reasonCode is required for every moderation action');
    err.statusCode = 400;
    err.code = 'reason_required';
    throw err;
  }

  return withTransaction(async (client) => {
    const { roles, permissions } = await loadAdminPermissions(client, actorId);
    requirePermission(actionId, permissions);
    const actorRole = primaryRole(roles);

    const result = await dispatchBusinessWrite(client, {
      action,
      actorId,
      actorRole,
      target,
      payload,
    });

    // moderation_actions (immutable history)
    await client.query(
      `insert into public.moderation_actions
         (case_id, actor_id, actor_kind, actor_role, action,
          target_type, target_id, before_state, after_state,
          reason_code, reason_text, metadata)
       values ($1,$2,'human',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        result.caseId ?? null,
        actorId,
        actorRole,
        actionId,
        action.targetType,
        String(target.id),
        result.before ?? null,
        result.after ?? null,
        payload.reasonCode,
        payload.reasonText ?? null,
        payload.metadata ?? {},
      ],
    );

    // admin_activity_log (hash-chained)
    await logAdminActivity(client, {
      requestId,
      actorId,
      actorRole,
      action: actionId,
      targetType: action.targetType,
      targetId: target.id,
      before: result.before,
      after: result.after,
      reasonCode: payload.reasonCode,
      reasonText: payload.reasonText,
      metadata: payload.metadata,
    });

    return result;
  });
}

async function dispatchBusinessWrite(client, ctx) {
  switch (ctx.action.id) {
    case ACTIONS.REPORT_ASSIGN.id:
      return assignReport(client, ctx);
    case ACTIONS.REPORT_DISMISS.id:
      return resolveReport(client, ctx, 'dismissed');
    case ACTIONS.REPORT_RESOLVE.id:
      return resolveReport(client, ctx, 'resolved');
    case ACTIONS.LISTING_HIDE.id:
      return setListingStatus(client, ctx, 'hidden');
    case ACTIONS.LISTING_RESTORE.id:
      return setListingStatus(client, ctx, 'active');
    case ACTIONS.LISTING_REMOVE.id:
      return setListingStatus(client, ctx, 'removed');
    case ACTIONS.USER_SUSPEND_TEMP.id:
    case ACTIONS.USER_SUSPEND_LONG.id:
    case ACTIONS.USER_SUSPEND_PERMANENT.id:
      return suspendUser(client, ctx);
    case ACTIONS.USER_UNSUSPEND.id:
      return unsuspendUser(client, ctx);
    case ACTIONS.USER_WARN.id:
      return warnUser(client, ctx);
    case ACTIONS.REQUEST_VERIFICATION.id:
      return requestVerification(client, ctx);
    case ACTIONS.VERIFICATION_APPROVE.id:
      return decideVerification(client, ctx, 'approved');
    case ACTIONS.VERIFICATION_REJECT.id:
      return decideVerification(client, ctx, 'rejected');
    case ACTIONS.CASE_ESCALATE.id:
      return escalateCase(client, ctx);
    case ACTIONS.APPEAL_DECIDE.id:
      return decideAppeal(client, ctx);
    case ACTIONS.VERIFICATION_EVIDENCE_VIEW.id:
      // read-only: nothing to mutate, but we still log it via admin_activity_log
      return { caseId: null, before: null, after: { viewed: ctx.target.id } };
    default:
      throw new Error(`No dispatcher for action ${ctx.action.id}`);
  }
}

// ---------- handlers ----------

async function assignReport(client, ctx) {
  const before = (await client.query(`select * from public.reports where id=$1`, [ctx.target.id])).rows[0];
  if (!before) throw notFound('report', ctx.target.id);
  const upd = await client.query(
    `update public.reports set status='in_review', assignee_id=$2 where id=$1 returning *`,
    [ctx.target.id, ctx.actorId],
  );
  return { caseId: before.case_id, before, after: upd.rows[0] };
}

async function resolveReport(client, ctx, status) {
  const before = (await client.query(`select * from public.reports where id=$1`, [ctx.target.id])).rows[0];
  if (!before) throw notFound('report', ctx.target.id);
  const upd = await client.query(
    `update public.reports set status=$2 where id=$1 returning *`,
    [ctx.target.id, status],
  );
  if (before.case_id) {
    await client.query(
      `update public.moderation_cases
          set status='resolved',
              decision=$2,
              decision_reason=$3,
              resolved_at=now()
        where id=$1 and status <> 'resolved'`,
      [before.case_id, status, ctx.payload.reasonText ?? ctx.payload.reasonCode],
    );
  }
  return { caseId: before.case_id, before, after: upd.rows[0] };
}

async function setListingStatus(client, ctx, status) {
  // Best-effort: works whether `listings` table exists or not. When it doesn't,
  // we still record the moderation_action so the audit trail is complete.
  let before = null;
  let after = { id: ctx.target.id, moderation_status: status };
  const exists = await client.query(`select to_regclass('public.listings') as t`);
  if (exists.rows[0].t) {
    const cur = await client.query(`select id, moderation_status from public.listings where id=$1`, [ctx.target.id]);
    before = cur.rows[0] ?? null;
    const upd = await client.query(
      `update public.listings set moderation_status=$2 where id=$1 returning id, moderation_status`,
      [ctx.target.id, status],
    );
    after = upd.rows[0] ?? after;
  }
  return { caseId: ctx.payload.caseId ?? null, before, after };
}

async function suspendUser(client, ctx) {
  const { durationDays = null, scope = 'full' } = ctx.payload;
  // Enforce role-specific max durations declared in actions.js
  if (ctx.action.maxDays != null && durationDays != null && durationDays > ctx.action.maxDays) {
    const err = new Error(`Duration ${durationDays}d exceeds role max ${ctx.action.maxDays}d`);
    err.statusCode = 403;
    throw err;
  }
  const endsAt =
    ctx.action.id === 'user.suspend.permanent' || durationDays == null
      ? null
      : new Date(Date.now() + durationDays * 86400 * 1000).toISOString();

  const ins = await client.query(
    `insert into public.user_suspensions
       (user_id, scope, ends_at, reason_code, reason_text, issued_by)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [ctx.target.id, scope, endsAt, ctx.payload.reasonCode, ctx.payload.reasonText ?? null, ctx.actorId],
  );

  // Update profile flag best-effort
  const exists = await client.query(`select to_regclass('public.user_profiles') as t`);
  if (exists.rows[0].t) {
    await client.query(
      `update public.user_profiles set moderation_status=$2 where id=$1`,
      [ctx.target.id, scope === 'full' ? 'suspended' : 'restricted'],
    );
  }
  return { caseId: ctx.payload.caseId ?? null, before: null, after: ins.rows[0] };
}

async function unsuspendUser(client, ctx) {
  const before = (await client.query(
    `select * from public.user_suspensions
      where user_id=$1 and lifted_at is null
      order by starts_at desc limit 1`,
    [ctx.target.id],
  )).rows[0];
  if (!before) throw notFound('active suspension', ctx.target.id);
  const upd = await client.query(
    `update public.user_suspensions
        set lifted_at=now(), lifted_by=$2
      where id=$1
      returning *`,
    [before.id, ctx.actorId],
  );
  const exists = await client.query(`select to_regclass('public.user_profiles') as t`);
  if (exists.rows[0].t) {
    await client.query(`update public.user_profiles set moderation_status='active' where id=$1`, [ctx.target.id]);
  }
  return { caseId: ctx.payload.caseId ?? null, before, after: upd.rows[0] };
}

async function warnUser(client, ctx) {
  // Warnings are not a state change on user; the moderation_action + audit row
  // is the record. Notification delivery is handled by the notifications worker.
  return { caseId: ctx.payload.caseId ?? null, before: null, after: { warned: ctx.target.id } };
}

async function requestVerification(client, ctx) {
  const ins = await client.query(
    `insert into public.verifications (user_id, type, status, requested_by)
       values ($1,$2,'requested',$3)
       returning *`,
    [ctx.target.id, ctx.payload.type ?? 'id', ctx.actorId],
  );
  return { caseId: ctx.payload.caseId ?? null, before: null, after: ins.rows[0] };
}

async function decideVerification(client, ctx, decision) {
  const before = (await client.query(`select * from public.verifications where id=$1`, [ctx.target.id])).rows[0];
  if (!before) throw notFound('verification', ctx.target.id);
  if (before.reviewer_id && before.reviewer_id === ctx.actorId && decision === 'approved') {
    // Don't let same reviewer approve their own prior review
    const err = new Error('Separation of duties: another reviewer must approve');
    err.statusCode = 403;
    throw err;
  }
  const isBusiness = before.type === 'business';
  const reviewerCol = isBusiness && before.reviewer_id && before.reviewer_id !== ctx.actorId
    ? 'second_reviewer_id'
    : 'reviewer_id';
  const upd = await client.query(
    `update public.verifications
        set status=$2, ${reviewerCol}=$3,
            decision_reason=$4, decided_at=now()
      where id=$1 returning *`,
    [ctx.target.id, decision, ctx.actorId, ctx.payload.reasonText ?? ctx.payload.reasonCode],
  );

  // Update profile flags on approval (best effort)
  if (decision === 'approved') {
    const exists = await client.query(`select to_regclass('public.user_profiles') as t`);
    if (exists.rows[0].t) {
      const col = before.type === 'business' ? 'verified_business'
                : before.type === 'id'       ? 'verified_id'
                : null;
      if (col) {
        await client.query(`update public.user_profiles set ${col}=true where id=$1`, [before.user_id]);
      }
    }
  }
  return { caseId: ctx.payload.caseId ?? null, before, after: upd.rows[0] };
}

async function escalateCase(client, ctx) {
  const before = (await client.query(`select * from public.moderation_cases where id=$1`, [ctx.target.id])).rows[0];
  if (!before) throw notFound('case', ctx.target.id);
  const upd = await client.query(
    `update public.moderation_cases set severity = least(5, severity + 1) where id=$1 returning *`,
    [ctx.target.id],
  );
  return { caseId: ctx.target.id, before, after: upd.rows[0] };
}

async function decideAppeal(client, ctx) {
  const before = (await client.query(`select * from public.moderation_cases where id=$1`, [ctx.target.id])).rows[0];
  if (!before) throw notFound('case', ctx.target.id);
  // Separation of duties: the same admin who took the original action can't decide its appeal
  const lastAction = (await client.query(
    `select actor_id from public.moderation_actions
      where case_id=$1 and actor_kind='human'
      order by occurred_at asc limit 1`,
    [ctx.target.id],
  )).rows[0];
  if (lastAction?.actor_id && lastAction.actor_id === ctx.actorId) {
    const err = new Error('Separation of duties: a different admin must decide this appeal');
    err.statusCode = 403;
    throw err;
  }
  const decision = ctx.payload.decision === 'overturn' ? 'overturned' : 'upheld';
  const upd = await client.query(
    `update public.moderation_cases
        set status='resolved',
            decision=$2,
            decision_reason=$3,
            resolved_at=now()
      where id=$1 returning *`,
    [ctx.target.id, decision, ctx.payload.reasonText ?? ctx.payload.reasonCode],
  );
  return { caseId: ctx.target.id, before, after: upd.rows[0] };
}

function notFound(kind, id) {
  const err = new Error(`${kind} not found: ${id}`);
  err.statusCode = 404;
  return err;
}
