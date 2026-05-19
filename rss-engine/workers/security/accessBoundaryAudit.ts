/**
 * Phase G — Access boundary audit.
 *
 * Walks the active grants/roles/tokens and flags:
 *   - unsafe admin exposure (admin RPC reachable from anon role)
 *   - expired rollout permissions
 *   - stale tokens
 *   - orphaned privileged users
 *
 * Pure compute. Host injects the grant inventory.
 */

export interface AdminGrant {
  /** RPC name or table.privilege. */
  resource: string;
  /** Roles that hold this grant. */
  roles: string[];
  /** True if the resource itself is admin-only (SECURITY DEFINER). */
  adminOnly: boolean;
}

export interface RolloutPermission {
  userId: string;
  scope: string;
  expiresAt: string | null;
  grantedAt: string;
}

export interface SessionToken {
  id: string;
  userId: string;
  issuedAt: string;
  lastUsedAt: string;
  scopes: string[];
}

export interface PrivilegedUser {
  userId: string;
  roles: string[];
  lastLoginAt: string | null;
  deactivated: boolean;
}

export type BoundaryFindingType =
  | 'unsafe_admin_exposure'
  | 'expired_rollout_permission'
  | 'stale_token'
  | 'orphaned_privileged_user';

export interface BoundaryFinding {
  type: BoundaryFindingType;
  severity: 'info' | 'warn' | 'severe';
  subject: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface AccessBoundaryConfig {
  /** Tokens older than this with no use are stale. Default 90d. */
  staleTokenMs?: number;
  /** Privileged users inactive longer than this are orphaned. Default 60d. */
  orphanedUserMs?: number;
  now?: () => Date;
}

export interface AccessBoundaryAudit {
  audit(input: {
    grants: AdminGrant[];
    rolloutPermissions: RolloutPermission[];
    tokens: SessionToken[];
    privileged: PrivilegedUser[];
  }): BoundaryFinding[];
}

const DANGEROUS_ROLES = new Set(['anon', 'public']);

export function createAccessBoundaryAudit(config: AccessBoundaryConfig = {}): AccessBoundaryAudit {
  const staleTokenMs = config.staleTokenMs ?? 90 * 86_400_000;
  const orphanedUserMs = config.orphanedUserMs ?? 60 * 86_400_000;
  const now = config.now ?? (() => new Date());

  return {
    audit({ grants, rolloutPermissions, tokens, privileged }) {
      const out: BoundaryFinding[] = [];
      const nowMs = now().getTime();

      for (const g of grants) {
        if (!g.adminOnly) continue;
        const leaked = g.roles.filter((r) => DANGEROUS_ROLES.has(r));
        if (leaked.length > 0) {
          out.push({
            type: 'unsafe_admin_exposure',
            severity: 'severe',
            subject: g.resource,
            message: `admin resource exposed to roles: ${leaked.join(', ')}`,
            detail: { roles: leaked },
          });
        }
      }

      for (const p of rolloutPermissions) {
        if (!p.expiresAt) continue;
        const exp = new Date(p.expiresAt).getTime();
        if (exp < nowMs) {
          out.push({
            type: 'expired_rollout_permission',
            severity: 'warn',
            subject: p.userId,
            message: `expired permission still on record: ${p.scope}`,
            detail: { expiredAt: p.expiresAt },
          });
        }
      }

      for (const t of tokens) {
        const lastUse = new Date(t.lastUsedAt).getTime();
        if (nowMs - lastUse > staleTokenMs) {
          out.push({
            type: 'stale_token',
            severity: t.scopes.includes('admin') ? 'severe' : 'warn',
            subject: t.id,
            message: `token unused for ${Math.floor((nowMs - lastUse) / 86_400_000)}d`,
            detail: { userId: t.userId, scopes: t.scopes },
          });
        }
      }

      for (const p of privileged) {
        if (p.deactivated) {
          // Deactivated but still listed as privileged → orphan.
          out.push({
            type: 'orphaned_privileged_user',
            severity: 'warn',
            subject: p.userId,
            message: 'deactivated user still holds privileged roles',
            detail: { roles: p.roles },
          });
          continue;
        }
        if (!p.lastLoginAt) continue;
        const last = new Date(p.lastLoginAt).getTime();
        if (nowMs - last > orphanedUserMs) {
          out.push({
            type: 'orphaned_privileged_user',
            severity: 'warn',
            subject: p.userId,
            message: `no login in ${Math.floor((nowMs - last) / 86_400_000)}d`,
            detail: { roles: p.roles },
          });
        }
      }

      return out;
    },
  };
}
