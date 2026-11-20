// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const load = async (hash) => {
  vi.resetModules();
  window.location.hash = hash;
  return import('./authLink');
};

describe('authLink', () => {
  beforeEach(() => { window.location.hash = ''; });

  it('detects an invite link', async () => {
    const m = await load('#access_token=abc&type=invite');
    expect(m.initialLink.type).toBe('invite');
    expect(m.needsPasswordSetup).toBe(true);
  });
  it('detects a recovery link', async () => {
    const m = await load('#access_token=abc&type=recovery');
    expect(m.needsPasswordSetup).toBe(true);
  });
  it('is quiet for a normal page load', async () => {
    const m = await load('');
    expect(m.needsPasswordSetup).toBe(false);
    expect(m.initialLink.error).toBeNull();
  });
  it('surfaces an expired-link error', async () => {
    const m = await load('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(m.initialLink.error).toBe('Email link is invalid or has expired');
    expect(m.needsPasswordSetup).toBe(false);
  });
});
