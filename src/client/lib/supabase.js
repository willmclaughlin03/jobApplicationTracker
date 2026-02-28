import { createBrowserClient } from "@supabase/ssr";

const clientURLSupabase = process.env.NEXT_PUBLIC_SUPABASE_URL
const clientKeySupabase = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!clientURLSupabase) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable');
}

if (!clientKeySupabase) {
  throw new Error('Missing SUPABASE_ANON_KEY environment variable');
}

export const supabase = createBrowserClient(clientURLSupabase, clientKeySupabase)