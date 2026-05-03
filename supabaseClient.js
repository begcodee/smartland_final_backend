import { createClient } from "@supabase/supabase-js";

/**
 * Optional Supabase REST/Auth admin client. Primary DB access uses `pg` + DATABASE_URL in src/config/db.js.
 * SUPABASE_URL must be https://<project>.supabase.co (never the postgres:// URI).
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL?.trim();
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.SUPABASE_KEY?.trim();

  if (!url || !key) return null;
  if (url.startsWith("postgres")) {
    console.warn(
      "[supabase] SUPABASE_URL must be the HTTPS project URL, not DATABASE_URL. Postgres pooling uses DATABASE_URL in db.js."
    );
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
