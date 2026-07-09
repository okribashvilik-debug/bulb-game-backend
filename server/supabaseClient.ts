/**
 * Supabase client, constructed once from the service_role key. This
 * process talks to Supabase as a trusted backend — the service key
 * bypasses Row Level Security entirely (see supabase/schema.sql), which
 * is exactly right here: this server IS the authority, there's no
 * per-request user session to scope reads/writes to.
 *
 * Never import this from anything that could end up in a browser bundle —
 * the service key must never leave this process.
 */
import { createClient } from '@supabase/supabase-js';
import { env } from './env';

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
  auth: {
    // This is a server process with a static service key, not an
    // interactive user session — no token refresh/persistence to manage.
    persistSession: false,
    autoRefreshToken: false,
  },
});
