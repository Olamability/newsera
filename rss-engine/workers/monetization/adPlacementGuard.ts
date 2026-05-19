/**
 * Phase G — Ad placement guard. (See header in module.)
 */

export interface AdSlotDescriptor {
  slotId: string;
  position: 'inline_1' | 'inline_2' | 'inline_3' | 'sidebar' | 'sticky_bottom';
  articleId: string;
  userId: string;
  sessionId: string;
  requestedAt: string;
}

export type AdGuardBlockReason =
  | 'density_per_article'
  | 'density_per_session'
  | 'duplicate_impression'
  | 'cooldown_active'
  | 'above_the_fold_spam'
  | 'invalid_position';

export type AdGuardVerdict =
  | { allowed: true; cooldownExpiresAt: string }
  | { allowed: false; reason: AdGuardBlockReason; detail?: Record<string, unknown> };

export interface AdPlacementGuardConfig {
  maxAdsPerArticle?: number;
  maxAdsPerSession?: number;
  cooldownMs?: number;
  aboveFoldPositions?: Array<AdSlotDescriptor['position']>;
  now?: () => Date;
  maxLedgerEntries?: number;
}

export interface AdPlacementGuard {
  evaluate(slot: AdSlotDescriptor): AdGuardVerdict;
  confirm(slot: AdSlotDescriptor): void;
  ledgerSize(): number;
  reset(): void;
}

interface LedgerEntry {
  slotId: string;
  articleId: string;
  userId: string;
  sessionId: string;
  position: AdSlotDescriptor['position'];
  at: number;
}

const VALID_POSITIONS = new Set<AdSlotDescriptor['position']>([
  'inline_1',
  'inline_2',
  'inline_3',
  'sidebar',
  'sticky_bottom',
]);

export function createAdPlacementGuard(config: AdPlacementGuardConfig = {}): AdPlacementGuard {
  const maxAdsPerArticle = Math.max(1, config.maxAdsPerArticle ?? 2);
  const maxAdsPerSession = Math.max(1, config.maxAdsPerSession ?? 8);
  const cooldownMs = Math.max(1_000, config.cooldownMs ?? 30_000);
  const aboveFold = new Set(config.aboveFoldPositions ?? ['inline_1', 'sticky_bottom']);
  const maxLedger = Math.max(128, config.maxLedgerEntries ?? 50_000);

  const ledger: LedgerEntry[] = [];

  function prune(currentMs: number): void {
    while (ledger.length > maxLedger) ledger.shift();
    const cutoff = currentMs - 60 * 60_000;
    while (ledger.length > 0 && ledger[0].at < cutoff) ledger.shift();
  }

  return {
    evaluate(slot) {
      const ts = new Date(slot.requestedAt).getTime();
      prune(ts);

      if (!VALID_POSITIONS.has(slot.position)) {
        return { allowed: false, reason: 'invalid_position' };
      }

      const articleHits = ledger.filter(
        (e) => e.articleId === slot.articleId && e.userId === slot.userId,
      ).length;
      if (articleHits >= maxAdsPerArticle) {
        return {
          allowed: false,
          reason: 'density_per_article',
          detail: { current: articleHits, max: maxAdsPerArticle },
        };
      }

      const sessionHits = ledger.filter((e) => e.sessionId === slot.sessionId).length;
      if (sessionHits >= maxAdsPerSession) {
        return {
          allowed: false,
          reason: 'density_per_session',
          detail: { current: sessionHits, max: maxAdsPerSession },
        };
      }

      const dup = ledger.find(
        (e) => e.slotId === slot.slotId && e.articleId === slot.articleId && e.userId === slot.userId,
      );
      if (dup) {
        return {
          allowed: false,
          reason: 'duplicate_impression',
          detail: { previousAt: new Date(dup.at).toISOString() },
        };
      }

      const lastInSlot = [...ledger]
        .reverse()
        .find((e) => e.slotId === slot.slotId && e.userId === slot.userId);
      if (lastInSlot && ts - lastInSlot.at < cooldownMs) {
        return {
          allowed: false,
          reason: 'cooldown_active',
          detail: { wait_ms: cooldownMs - (ts - lastInSlot.at) },
        };
      }

      if (aboveFold.has(slot.position)) {
        const foldCount = ledger.filter(
          (e) =>
            e.articleId === slot.articleId &&
            e.userId === slot.userId &&
            aboveFold.has(e.position),
        ).length;
        if (foldCount >= 1) {
          return { allowed: false, reason: 'above_the_fold_spam', detail: { current: foldCount } };
        }
      }

      return { allowed: true, cooldownExpiresAt: new Date(ts + cooldownMs).toISOString() };
    },

    confirm(slot) {
      const ts = new Date(slot.requestedAt).getTime();
      ledger.push({
        slotId: slot.slotId,
        articleId: slot.articleId,
        userId: slot.userId,
        sessionId: slot.sessionId,
        position: slot.position,
        at: ts,
      });
      prune(ts);
    },

    ledgerSize() {
      return ledger.length;
    },

    reset() {
      ledger.length = 0;
    },
  };
}
