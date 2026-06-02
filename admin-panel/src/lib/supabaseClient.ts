import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    '[Admin] Missing required environment variables: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. ' +
    'Copy admin-panel/.env.example to admin-panel/.env and fill in your Supabase project credentials.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    debug: false,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
