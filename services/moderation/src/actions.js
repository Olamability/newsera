/**
 * Action catalog: the only mutations the moderation service is allowed to make.
 * Each action declares the permission required and the SQL change it implies.
 *
 * Keeping this declarative makes role/permission enforcement uniform across
 * the API surface and easy to audit.
 */

export const ACTIONS = Object.freeze({
  REPORT_ASSIGN: {
    id: 'report.assign',
    permission: 'reports.triage',
    targetType: 'report',
    description: 'Assign a report to a moderator (claim).',
  },
  REPORT_DISMISS: {
    id: 'report.dismiss',
    permission: 'cases.act',
    targetType: 'report',
    description: 'Dismiss a report with reason.',
  },
  REPORT_RESOLVE: {
    id: 'report.resolve',
    permission: 'cases.act',
    targetType: 'report',
    description: 'Resolve a report (action taken on target).',
  },
  CASE_ASSIGN: {
    id: 'case.assign',
    permission: 'cases.act',
    targetType: 'case',
  },
  LISTING_HIDE: {
    id: 'listing.hide',
    permission: 'listing.hide',
    targetType: 'listing',
    reversible: true,
  },
  LISTING_RESTORE: {
    id: 'listing.restore',
    permission: 'listing.hide',
    targetType: 'listing',
  },
  LISTING_REMOVE: {
    id: 'listing.remove',
    permission: 'listing.remove',
    targetType: 'listing',
  },
  USER_WARN: {
    id: 'user.warn',
    permission: 'user.warn',
    targetType: 'user',
  },
  USER_SUSPEND_TEMP: {
    id: 'user.suspend.temp',
    permission: 'user.suspend.temp',
    targetType: 'user',
    maxDays: 7,
  },
  USER_SUSPEND_LONG: {
    id: 'user.suspend.long',
    permission: 'user.suspend.long',
    targetType: 'user',
    maxDays: 90,
  },
  USER_SUSPEND_PERMANENT: {
    id: 'user.suspend.permanent',
    permission: 'user.suspend.permanent',
    targetType: 'user',
  },
  USER_UNSUSPEND: {
    id: 'user.unsuspend',
    permission: 'user.suspend.temp',
    targetType: 'user',
  },
  REQUEST_VERIFICATION: {
    id: 'verification.request',
    permission: 'cases.act',
    targetType: 'user',
  },
  VERIFICATION_APPROVE: {
    id: 'verification.approve',
    permission: 'verifications.decide',
    targetType: 'verification',
  },
  VERIFICATION_REJECT: {
    id: 'verification.reject',
    permission: 'verifications.decide',
    targetType: 'verification',
  },
  VERIFICATION_EVIDENCE_VIEW: {
    id: 'verification.evidence.view',
    permission: 'verifications.evidence.read',
    targetType: 'verification',
    sensitive: true,
  },
  CASE_ESCALATE: {
    id: 'case.escalate',
    permission: 'cases.act',
    targetType: 'case',
  },
  APPEAL_DECIDE: {
    id: 'appeal.decide',
    permission: 'appeals.decide',
    targetType: 'case',
  },
});

export function actionById(id) {
  return Object.values(ACTIONS).find((a) => a.id === id);
}
