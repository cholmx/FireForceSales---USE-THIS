// One-time migration to Supabase Auth. Run locally (never ship the service key to the browser):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OFFICE_USERNAME=ffoffice1 OFFICE_PASSWORD='<new strong pw>' \
//   node scripts/bootstrap-auth.mjs
// 1. Creates the office admin (OFFICE_USERNAME/OFFICE_PASSWORD, 8+ chars).
// 2. Creates auth accounts for existing salesmen, reusing their old password as a temporary one
//    (anything under 8 chars gets a random one printed below). Then nulls password_hash.
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OFFICE_USERNAME, OFFICE_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OFFICE_USERNAME || !OFFICE_PASSWORD || OFFICE_PASSWORD.length < 8) {
  console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OFFICE_USERNAME, OFFICE_PASSWORD (8+ chars)');
  process.exit(1);
}
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const emailFor = (u) => `${u.trim().toLowerCase()}@fireforce.local`;

async function ensureAuthUser(username, password) {
  const { data, error } = await admin.auth.admin.createUser({ email: emailFor(username), password, email_confirm: true, user_metadata: { must_change_password: true } });
  if (error) throw new Error(`${username}: ${error.message}`);
  return data.user.id;
}

// Office admin
const { data: existingOffice } = await admin.from('users_ff2024').select('id').eq('username', OFFICE_USERNAME).maybeSingle();
if (!existingOffice) {
  const id = await ensureAuthUser(OFFICE_USERNAME, OFFICE_PASSWORD);
  const { error } = await admin.from('users_ff2024').insert({ username: OFFICE_USERNAME, name: 'Office Administrator', role: 'office', auth_id: id });
  if (error) throw error;
  console.log(`Created office admin ${OFFICE_USERNAME}`);
}

// Existing salesmen
const { data: reps } = await admin.from('users_ff2024').select('*').is('auth_id', null).eq('role', 'salesman');
for (const r of reps ?? []) {
  let pw = r.password_hash;
  let generated = false;
  if (!pw || pw.length < 8) { pw = randomBytes(9).toString('base64url'); generated = true; }
  try {
    const id = await ensureAuthUser(r.username, pw);
    await admin.from('users_ff2024').update({ auth_id: id, ...('password_hash' in r ? { password_hash: null } : {}) }).eq('id', r.id);
    console.log(`Migrated ${r.username}${generated ? ` — temporary password: ${pw}` : ' (kept existing password; ask them to change it)'}`);
  } catch (e) { console.error('FAILED', e.message); }
}
// Clear any leftover plaintext passwords (errors harmlessly if this database never had the column)
await admin.from('users_ff2024').update({ password_hash: null }).not('auth_id', 'is', null);
console.log('Done. Now apply the secure_auth_and_rls migration and rotate any password that was in the old source.');
