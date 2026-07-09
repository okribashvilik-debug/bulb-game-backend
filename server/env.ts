/**
 * Environment loading + validation — the one place process.env is read.
 * Everything else imports from here instead of touching process.env
 * directly, so a missing/misconfigured variable fails loudly at boot
 * (before any WebSocket connection or Supabase call can hit it) rather
 * than as a confusing runtime error three layers deep.
 *
 * Local dev: create a `.env` file (see .env.example) — dotenv loads it.
 * On Render: set these as service environment variables in the dashboard;
 * dotenv's `config()` call below is a no-op if no `.env` file exists, so
 * it's safe to leave in for both environments.
 */
import 'dotenv/config';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". Copy .env.example to .env and fill it in ` +
        `(local dev), or set it in the Render dashboard's Environment tab (deployed).`,
    );
  }
  return value;
}

export const env = {
  SUPABASE_URL: requireEnv('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: requireEnv('SUPABASE_SERVICE_KEY'),
  /** Render assigns this dynamically — always read it, never hardcode a port. */
  PORT: Number(process.env.PORT ?? 3000),
};
