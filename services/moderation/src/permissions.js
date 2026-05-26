import { actionById } from './actions.js';

/**
 * Resolve the roles + permissions for a user. Returns { roles, permissions }.
 * Uses the supplied pg client so callers may reuse a transaction.
 */
export async function loadAdminPermissions(client, userId) {
  if (!userId) return { roles: [], permissions: new Set() };
  const { rows } = await client.query(
    `select a.role_id, p.permission
       from public.admin_role_assignments a
       join public.role_permissions p on p.role_id = a.role_id
      where a.user_id = $1`,
    [userId],
  );
  const roles = [...new Set(rows.map((r) => r.role_id))];
  const permissions = new Set(rows.map((r) => r.permission));
  return { roles, permissions };
}

/** Highest-privilege role wins for audit logging purposes. */
const ROLE_RANK = [
  'admin',
  'ts_lead',
  'senior_moderator',
  'verification_reviewer',
  'moderator',
  'viewer',
  'system',
];

export function primaryRole(roles) {
  for (const r of ROLE_RANK) if (roles.includes(r)) return r;
  return roles[0] || null;
}

/**
 * Throws a PermissionError if `permissions` does not include the permission
 * required by `actionId`.
 */
export function requirePermission(actionId, permissions) {
  const action = actionById(actionId);
  if (!action) {
    const err = new Error(`Unknown action: ${actionId}`);
    err.statusCode = 400;
    throw err;
  }
  if (!permissions.has(action.permission)) {
    const err = new Error(
      `Permission denied: action "${actionId}" requires "${action.permission}"`,
    );
    err.statusCode = 403;
    err.code = 'permission_denied';
    throw err;
  }
  return action;
}
