// Sign-in identifiers. Accounts sign in with their email address. Anything typed without an "@" is treated as a
// legacy username and mapped to the synthetic address those accounts were created with, so existing logins keep
// working until their email is updated under Office -> Users.
export const LEGACY_EMAIL_DOMAIN = 'fireforce.local';

export const loginIdToEmail = (id) => {
  const v = String(id ?? '').trim().toLowerCase();
  return v.includes('@') ? v : `${v}@${LEGACY_EMAIL_DOMAIN}`;
};

export const isValidEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v ?? '').trim());
