import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (!connectionString) {
      throw new Error('[moderation] DATABASE_URL (or SUPABASE_DB_URL) is required');
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

/**
 * Run `fn(client)` inside a transaction. The callback receives a pg client.
 * The transaction is rolled back if `fn` throws.
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
