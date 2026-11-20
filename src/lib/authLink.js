// Invite and password-reset emails send people back to the app with tokens in the URL hash
// (e.g. "#access_token=...&type=invite"). supabase-js consumes and clears that hash as soon as its client is
// created, so this module must be imported BEFORE anything that imports the client (see main.jsx).
const hash = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
const params = new URLSearchParams(hash);

export const initialLink = {
  type: params.get('type'),   // 'invite' | 'recovery' | ...
  error: params.get('error') || params.get('error_code')
    ? (params.get('error_description') || 'This link is invalid or has expired.').replace(/\+/g, ' ')
    : null,
};

export const needsPasswordSetup = initialLink.type === 'invite' || initialLink.type === 'recovery';
