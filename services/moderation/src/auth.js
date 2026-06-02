import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

let supabase;
if (supabaseUrl && supabaseAnonKey) {
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });
}

/**
 * Middleware to strictly require a valid Supabase JWT.
 * It will attach the verified user's ID to `req.actorId`.
 */
export async function requireAuth(req, res, next) {
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase URL/Key not configured in moderation service' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    req.actorId = user.id;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware that extracts the actor ID if a valid token is present,
 * but proceeds even if it is not (e.g., for anonymous reporting).
 */
export async function optionalAuth(req, res, next) {
  if (!supabase) return next();

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        req.actorId = user.id;
      }
    } catch (err) {
      // Ignore token verification errors for optional auth
    }
  }
  next();
}
