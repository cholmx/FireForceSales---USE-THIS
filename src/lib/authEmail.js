// Usernames map to a synthetic email for Supabase Auth. Keep in sync with the manage-users function.
export const usernameToEmail = (username) => `${String(username).trim().toLowerCase()}@fireforce.local`;
