import { createClient } from '@supabase/supabase-js'

// Fallbacks baked in because the hosted dev server may not load .env at startup.
// The anon key is public by design; data access is enforced by RLS.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://ebitgnxnhqzpcvgbvucn.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImViaXRnbnhuaHF6cGN2Z2J2dWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxMzE2MjcsImV4cCI6MjExMDcwNzYyN30.PXFvR1J3jL5L9b-HULUygCwMh-tWjuwYF_RU6wW99is'

export default createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
})