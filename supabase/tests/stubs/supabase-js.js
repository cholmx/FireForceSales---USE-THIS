// Test stand-in for the esm.sh import used inside the Edge Function (see vite.config.js test.alias).
export const createClient = (...args) => globalThis.__fakeCreateClient(...args);
