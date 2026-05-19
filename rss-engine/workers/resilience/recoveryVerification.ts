/**
 * Phase G — Recovery verification.
 *
 * After a backup is taken (or before a real restore), this module checks
 * the integrity of every replayable surface the platform depends on:
 *
 *   - replay integrity              — event-log → state convergence
 *   - queue recovery integrity      — pending/inflight jobs survive
 *   - notification replay safety    — no duplicate fanout on replay
 *   - ranking rebuild integrity     — ranks regenerate to within tolerance
 *   - personalized cache recovery   — per-user state can be rebuilt
 *   - worker-state recovery         — lease/heartbeat reconstitution
 *
 * Pure compute. The host injects observations; the module classifies and
 * scores them.
 */

export interface ReplayObservation {
  replayedEvents: number;
  postReplayStateChecksum: string;
  expectedStateChecksum: string;
}

export interface QueueRecoveryObservation {
  preCrashPending: number;
  postRecoveryPending: number;
  preCrashInflight: number;
  postRecoveryInflight: number;
  /** Jobs that vanished entirely (must be zero for integrity). */
  lostJobIds: string[];
}

export interface NotificationReplayObservation {
  /** Notifications previously delivered prior to recovery. */
  alreadyDeliveredIds: string[];
  /** Notifications attempted in the replay window. */
  attemptedIds: string[];
  /** Notifications actually dispatched after dedup. */
  dispatchedIds: string[];
}

export interface RankingRebuildObservation {
  /** Number of articles whose new rank differs from old rank. */
  changedCount: number;
  /** Total articles ranked. */
  totalCount: number;
  /** Sum of absolute rank deltas / totalCount. */
  averageRankDelta: number;
  /** Acceptable per-article rank delta. Default 5. */
  toleranceDelta?: number;
}

export interface PersonalizationCacheObservation {
  totalUsers: number;
  rebuiltUsers: number;
  failedUsers: string[];
}

export interface WorkerStateRecoveryObservation {
  expectedWorkers: string[];
  recoveredWorkers: string[];
  /** Workers whose lease did not transfer cleanly. */
  orphanedLeases: string[];
}

export interface RecoveryVerificationInput {
  replay?: ReplayObservation;
  queues?: QueueRecoveryObservation;
  notifications?: NotificationReplayObservation;
  rankingRebuild?: RankingRebuildObservation;
  personalizationCache?: PersonalizationCacheObservation;
  workerState?: WorkerStateRecoveryObservation;
}

export type RecoveryComponentStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface RecoveryComponentReport {
  component: string;
  status: RecoveryComponentStatus;
  score: number; // 0..1
  findings: string[];
}

export interface RecoveryVerificationReport {
  components: RecoveryComponentReport[];
  /** Geometric-style aggregate; any 'fail' drags the score below 0.5. */
  confidenceScore: number;
  status: RecoveryComponentStatus;
}

function verifyReplay(obs?: ReplayObservation): RecoveryComponentReport {
  if (!obs) return { component: 'replay', status: 'skipped', score: 1, findings: [] };
  const matches = obs.postReplayStateChecksum === obs.expectedStateChecksum;
  return {
    component: 'replay',
    status: matches ? 'pass' : 'fail',
    score: matches ? 1 : 0,
    findings: matches ? [] : [`checksum mismatch: ${obs.postReplayStateChecksum} != ${obs.expectedStateChecksum}`],
  };
}

function verifyQueues(obs?: QueueRecoveryObservation): RecoveryComponentReport {
  if (!obs) return { component: 'queues', status: 'skipped', score: 1, findings: [] };
  const findings: string[] = [];
  let status: RecoveryComponentStatus = 'pass';
  let score = 1;
  if (obs.lostJobIds.length > 0) {
    status = 'fail';
    score = 0;
    findings.push(`lost ${obs.lostJobIds.length} job(s)`);
  } else {
    const pendingDelta = Math.abs(obs.preCrashPending - obs.postRecoveryPending);
    if (pendingDelta > Math.max(1, obs.preCrashPending * 0.05)) {
      status = 'warn';
      score = 0.7;
      findings.push(`pending count drifted by ${pendingDelta}`);
    }
    const inflightDelta = Math.abs(obs.preCrashInflight - obs.postRecoveryInflight);
    if (inflightDelta > Math.max(1, obs.preCrashInflight * 0.1)) {
      status = status === 'pass' ? 'warn' : status;
      score = Math.min(score, 0.6);
      findings.push(`inflight count drifted by ${inflightDelta}`);
    }
  }
  return { component: 'queues', status, score, findings };
}

function verifyNotifications(obs?: NotificationReplayObservation): RecoveryComponentReport {
  if (!obs) return { component: 'notifications', status: 'skipped', score: 1, findings: [] };
  const delivered = new Set(obs.alreadyDeliveredIds);
  const dupes = obs.dispatchedIds.filter((id) => delivered.has(id));
  if (dupes.length === 0) {
    return { component: 'notifications', status: 'pass', score: 1, findings: [] };
  }
  return {
    component: 'notifications',
    status: 'fail',
    score: Math.max(0, 1 - dupes.length / Math.max(1, obs.attemptedIds.length)),
    findings: [`${dupes.length} duplicate notification dispatches`],
  };
}

function verifyRanking(obs?: RankingRebuildObservation): RecoveryComponentReport {
  if (!obs) return { component: 'ranking_rebuild', status: 'skipped', score: 1, findings: [] };
  const tolerance = obs.toleranceDelta ?? 5;
  if (obs.totalCount === 0) {
    return { component: 'ranking_rebuild', status: 'pass', score: 1, findings: [] };
  }
  const changeRate = obs.changedCount / obs.totalCount;
  if (obs.averageRankDelta > tolerance * 2 || changeRate > 0.5) {
    return {
      component: 'ranking_rebuild',
      status: 'fail',
      score: 0.1,
      findings: [`rank delta=${obs.averageRankDelta.toFixed(2)} change_rate=${changeRate.toFixed(2)}`],
    };
  }
  if (obs.averageRankDelta > tolerance) {
    return {
      component: 'ranking_rebuild',
      status: 'warn',
      score: 0.6,
      findings: [`rank delta=${obs.averageRankDelta.toFixed(2)} exceeds tolerance ${tolerance}`],
    };
  }
  return { component: 'ranking_rebuild', status: 'pass', score: 1, findings: [] };
}

function verifyPersonalization(obs?: PersonalizationCacheObservation): RecoveryComponentReport {
  if (!obs) return { component: 'personalization_cache', status: 'skipped', score: 1, findings: [] };
  if (obs.totalUsers === 0) {
    return { component: 'personalization_cache', status: 'pass', score: 1, findings: [] };
  }
  const failRate = obs.failedUsers.length / obs.totalUsers;
  const rebuildRate = obs.rebuiltUsers / obs.totalUsers;
  if (failRate > 0.05) {
    return {
      component: 'personalization_cache',
      status: 'fail',
      score: 1 - failRate,
      findings: [`${obs.failedUsers.length}/${obs.totalUsers} users failed to rebuild`],
    };
  }
  if (rebuildRate < 0.95) {
    return {
      component: 'personalization_cache',
      status: 'warn',
      score: rebuildRate,
      findings: [`only ${(rebuildRate * 100).toFixed(0)}% rebuilt`],
    };
  }
  return { component: 'personalization_cache', status: 'pass', score: 1, findings: [] };
}

function verifyWorkerState(obs?: WorkerStateRecoveryObservation): RecoveryComponentReport {
  if (!obs) return { component: 'worker_state', status: 'skipped', score: 1, findings: [] };
  const expected = new Set(obs.expectedWorkers);
  const recovered = new Set(obs.recoveredWorkers);
  const missing = [...expected].filter((w) => !recovered.has(w));
  const findings: string[] = [];
  let status: RecoveryComponentStatus = 'pass';
  let score = 1;
  if (missing.length > 0) {
    status = 'fail';
    score = Math.max(0, 1 - missing.length / Math.max(1, expected.size));
    findings.push(`${missing.length} worker(s) did not recover`);
  }
  if (obs.orphanedLeases.length > 0) {
    status = status === 'pass' ? 'warn' : status;
    score = Math.min(score, 0.7);
    findings.push(`${obs.orphanedLeases.length} orphaned lease(s)`);
  }
  return { component: 'worker_state', status, score, findings };
}

export function verifyRecovery(input: RecoveryVerificationInput): RecoveryVerificationReport {
  const components: RecoveryComponentReport[] = [
    verifyReplay(input.replay),
    verifyQueues(input.queues),
    verifyNotifications(input.notifications),
    verifyRanking(input.rankingRebuild),
    verifyPersonalization(input.personalizationCache),
    verifyWorkerState(input.workerState),
  ];
  const active = components.filter((c) => c.status !== 'skipped');
  const hasFail = active.some((c) => c.status === 'fail');
  const hasWarn = active.some((c) => c.status === 'warn');
  const confidenceScore =
    active.length === 0 ? 1 : active.reduce((s, c) => s + c.score, 0) / active.length * (hasFail ? 0.4 : 1);
  const status: RecoveryComponentStatus = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';
  return { components, confidenceScore, status };
}
