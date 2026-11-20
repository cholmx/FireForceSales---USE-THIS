// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';

// Minimal fake of the Supabase client that fires the same auth events the real one does.
const h = vi.hoisted(() => {
  const state = { listener: null, metadata: { must_change_password: true } };
  const sessionFor = (meta) => ({ user: { id: 'auth-1', user_metadata: { ...meta } } });
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
    from: vi.fn(() => ({
      select: () => ({ eq: () => ({
        // slow-ish profile fetch, like a network round trip
        maybeSingle: () => new Promise((r) => setTimeout(() => r({ data: { id: 'u1', username: 'ffoffice1', name: 'Office', role: 'office' }, error: null }), 20)),
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
  return <div data-testid="flag">{api.loading ? 'loading' : api.user ? `must=${api.user.mustChangePassword}` : 'signed-out'}</div>;
};

describe('forced password change', () => {
  beforeEach(() => { h.state.metadata = { must_change_password: true }; h.state.listener = null; });
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
});
