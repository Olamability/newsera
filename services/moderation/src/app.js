import express from 'express';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { getPool } from './db.js';
import { intakeReport, applyAction } from './handlers.js';

/**
 * Build the moderation API. Auth is expected to be enforced by an upstream
 * gateway that maps the bearer token to a user id and forwards it in the
 * `x-actor-id` header. In production, replace `actorFromRequest` with proper
 * Supabase JWT verification.
 */
export function buildApp({ logger = console } = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Request id propagation (UI → service → DB log)
  app.use((req, _res, next) => {
    req.requestId = req.header('x-request-id') || randomUUID();
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Rate-limit every DB-touching endpoint. Per-actor when present, falling
  // back to remote IP. Tighter bucket on mutation endpoints below. We apply
  // it as a global middleware so every current and future DB-touching route
  // is covered by default.
  const keyFn = (req) => req.header('x-actor-id') || req.ip || 'anon';
  const readLimiter  = rateLimit({ windowMs: 60_000, limit: 300, keyGenerator: keyFn,
                                   standardHeaders: 'draft-7', legacyHeaders: false });
  const writeLimiter = rateLimit({ windowMs: 60_000, limit:  60, keyGenerator: keyFn,
                                   standardHeaders: 'draft-7', legacyHeaders: false });
  app.use(readLimiter);

  // ---------- Reports ----------
  app.post('/v1/reports', writeLimiter, async (req, res, next) => {
    try {
      const result = await intakeReport(req.body, { requestId: req.requestId });
      res.status(201).json(result);
    } catch (e) { next(e); }
  });

  app.get('/v1/queue', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const { rows } = await getPool().query(
        `select * from public.report_queue order by priority desc, created_at asc limit $1`,
        [limit],
      );
      res.json({ items: rows });
    } catch (e) { next(e); }
  });

  app.get('/v1/cases/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const pool = getPool();
      const [c, reports, actions, signals] = await Promise.all([
        pool.query(`select * from public.moderation_cases where id=$1`, [id]),
        pool.query(`select * from public.reports where case_id=$1 order by created_at`, [id]),
        pool.query(`select * from public.moderation_actions where case_id=$1 order by occurred_at`, [id]),
        pool.query(
          `select * from public.fraud_signals s
            join public.moderation_cases c on c.target_type=s.subject_type and c.target_id=s.subject_id
            where c.id=$1 order by s.occurred_at desc limit 100`, [id],
        ),
      ]);
      if (!c.rows[0]) return res.status(404).json({ error: 'case_not_found' });
      res.json({
        case: c.rows[0],
        reports: reports.rows,
        actions: actions.rows,
        signals: signals.rows,
      });
    } catch (e) { next(e); }
  });

  // ---------- Actions ----------
  // Generic action endpoint — keeps permission/audit logic in one place.
  app.post('/v1/actions/:actionId', writeLimiter, async (req, res, next) => {
    try {
      const actorId = req.header('x-actor-id');
      const { actionId } = req.params;
      const { target, payload } = req.body ?? {};
      if (!target?.id) return res.status(400).json({ error: 'target.id required' });
      const result = await applyAction({
        actorId,
        actionId,
        target,
        payload,
        requestId: req.requestId,
      });
      res.json(result);
    } catch (e) { next(e); }
  });

  // ---------- Audit ----------
  app.get('/v1/audit/log', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const { rows } = await getPool().query(
        `select id, occurred_at, request_id, actor_id, actor_role, action,
                target_type, target_id, reason_code, prev_hash, row_hash
           from public.admin_activity_log
          order by id desc limit $1`,
        [limit],
      );
      res.json({ items: rows });
    } catch (e) { next(e); }
  });

  app.get('/v1/audit/verify', async (_req, res, next) => {
    try {
      const { rows } = await getPool().query(`select broken_at from public.verify_admin_activity_chain()`);
      res.json({ ok: rows.length === 0, broken_at: rows[0]?.broken_at ?? null });
    } catch (e) { next(e); }
  });

  // ---------- Error handler ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.statusCode || 500;
    if (status >= 500) logger.error?.('[moderation] error', err);
    res.status(status).json({
      error: err.code || err.message,
      message: err.message,
      requestId: req.requestId,
    });
  });

  return app;
}
