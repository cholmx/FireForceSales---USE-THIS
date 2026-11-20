// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';

// Minimal fake of the Supabase client that fires the same auth events the real one does.
const h = vi.hoisted(() => {
  const state = { listener: null, metadata: { must_change_password: true }, role: 'office' };
  const sessionFor = (meta) => ({ user: { id: 'auth-1', email: 'boss@example.com', user_metadata: { ...meta } } });
  const supabase = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: sessionFor(state.metadata) } })),
      onAuthStateChange: vi.fn((cb) => { state.listener = cb; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
      // Re-verifying the current password signs in again, which makes the real client emit SIGNED_IN
      // carrying the session as it was BEFORE the password change (flag still set).
      signInWithPassword: vi.fn(async () => {
        const session = sessionFor(state.metadata);
        state.listener?.('SIGNED_IN', session);
        return { data: { user: session.user, session }, error: null };
      }),
      updateUser: vi.fn(async ({ data }) => {
        state.metadata = { ...state.metadata, ...data };
        const session = sessionFor(state.metadata);
        state.listener?.('USER_UPDATED', session);
        return { data: { user: session.user }, error: null };
      }),
      signOut: vi.fn(async () => { state.listener?.('SIGNED_OUT', null); return { error: null }; }),
    },
    functions: { invoke: vi.fn(async () => ({ data: { ok: true }, error: null })) },
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({
        // slow-ish profile fetch, like a network round trip
        maybeSingle: () => new Promise((r) => setTimeout(() => r({ data: { id: 'u1', username: 'ffoffice1', name: 'Office', role: state.role }, error: null }), 20)),
      }) }),
    })),
  };
  return { state, supabase };
});
vi.mock('../lib/supabase', () => ({ default: h.supabase }));

import { AuthProvider, useAuth } from './AuthContext';

let api;
const Probe = () => {
  api = useAuth();
  return <div><div data-testid="flag">{api.loading ? 'loading' : api.user ? `must=${api.user.mustChangePassword}` : 'signed-out'}</div><div data-testid="level">{api.user ? `owner=${api.user.isOwner} office=${api.user.isOffice}` : ''}</div></div>;
};

describe('forced password change', () => {
  beforeEach(() => { h.state.metadata = { must_change_password: true }; h.state.listener = null; h.state.role = 'office'; h.supabase.auth.signInWithPassword.mockClear(); });
  afterEach(() => cleanup());

  it('clears the flag and stays cleared after the password is changed', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('flag').textContent).toBe('must=true'));

    let result;
    await act(async () => { result = await api.changePassword('old-temporary-pw', 'a-brand-new-password'); });
    expect(result).toEqual({ success: true });

    // let any late profile reloads triggered by the re-verification sign-in settle
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(screen.getByTestId('flag').textContent).toBe('must=false');
  });

  it('keeps the user signed in when a duplicate SIGNED_IN event arrives (e.g. tab refocus)', async () => {
    h.state.metadata = {};
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('flag').textContent).toBe('must=false'));
    await act(async () => { h.state.listener('SIGNED_IN', { user: { id: 'auth-1', user_metadata: {} } }); await new Promise((r) => setTimeout(r, 80)); });
    expect(screen.getByTestId('flag').textContent).toBe('must=false');
  });

  it('marks the main admin as owner and office-level, an Office Admin as office-level only, Sales as neither', async () => {
    for (const [role, expected] of [['owner', 'owner=true office=true'], ['office', 'owner=false office=true'], ['salesman', 'owner=false office=false']]) {
      cleanup();
      h.state.metadata = {};
      h.state.role = role;
      render(<AuthProvider><Probe /></AuthProvider>);
      await waitFor(() => expect(screen.getByTestId('level').textContent).toBe(expected));
    }
  });

  it('signs in with an email as typed, and maps a legacy username to its old address', async () => {
    h.state.metadata = {};
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('flag').textContent).toBe('must=false'));
    await act(async () => { await api.login('  Boss@Example.com ', 'pw'); });
    expect(h.supabase.auth.signInWithPassword).toHaveBeenLastCalledWith({ email: 'boss@example.com', password: 'pw' });
    await act(async () => { await api.login('ffoffice1', 'pw'); });
    expect(h.supabase.auth.signInWithPassword).toHaveBeenLastCalledWith({ email: 'ffoffice1@fireforce.local', password: 'pw' });
  });

  it('sends "forgot password" through the manage-users function (Resend), lowercased, with the app address to return to', async () => {
    h.state.metadata = {};
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('flag').textContent).toBe('must=false'));
    let result;
    await act(async () => { result = await api.requestPasswordReset('  Boss@Example.com '); });
    expect(result).toEqual({ success: true });
    expect(h.supabase.functions.invoke).toHaveBeenCalledWith('manage-users', {
      body: { action: 'request_reset', email: 'boss@example.com', redirectTo: window.location.origin },
    });
  });

  it('tells the person to try again if the reset email could not be requested', async () => {
    h.supabase.functions.invoke.mockResolvedValueOnce({ data: null, error: new Error('network') });
    h.state.metadata = {};
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('flag').textContent).toBe('must=false'));
    let result;
    await act(async () => { result = await api.requestPasswordReset('boss@example.com'); });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/try again/i);
  });
});
