import { createClient } from "@supabase/supabase-js";

// The browser's ANON Supabase client (M1D). RLS-enforced and public-safe — it can only SELECT
// result_events (via the anon read policy) and subscribe to Realtime. The service_role key NEVER
// reaches the browser. If the env isn't set we expose `null` so the UI shows an honest "not
// configured" state instead of crashing.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured ? createClient(url as string, anonKey as string) : null;
