import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import supabase from '../lib/supabase';
import { loginIdToEmail } from '../lib/authEmail';
import { initialLink, needsPasswordSetup } from '../lib/authLink';
import { isOfficeLevel } from '../lib/roles';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // True after following an invite / password-reset email link: the person must choose a password.
  const [passwordSetup, setPasswordSetup] = useState(needsPasswordSetup);
  // Auth user id whose profile is currently loaded; lets us ignore repeat SIGNED_IN events for the same user.
  const loadedAuthId = useRef(null);

  const loadProfile = async (authUser) => {
    if (!authUser) { loadedAuthId.current = null; setUser(null); return null; }
    const { data, error } = await supabase
      .from('users_ff2024')
      .select('id, username, name, role')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (error || !data) { loadedAuthId.current = null; setUser(null); return null; }
    loadedAuthId.current = authUser.id;
    const profile = { ...data, isOwner: data.role === 'owner', isOffice: isOfficeLevel(data.role), loginEmail: authUser.email, mustChangePassword: authUser.user_metadata?.must_change_password === true };
    setUser(profile);
    return profile;
  };

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (active) await loadProfile(data.session?.user ?? null);
      if (active) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordSetup(true);
      } else if (event === 'SIGNED_OUT') {
        loadedAuthId.current = null;
        setPasswordSetup(false);
        setUser(null);
      } else if (event === 'SIGNED_IN') {
        // Supabase also emits SIGNED_IN when the tab regains focus and when we re-verify a password.
        // Reloading then would use a stale session (e.g. the "must change password" flag from before
        // the change), so only load when it's a different user than the one we already have.
        if (session?.user?.id && session.user.id === loadedAuthId.current) return;
        // defer to avoid deadlocking inside the auth callback
        setTimeout(() => active && loadProfile(session?.user ?? null), 0);
      } else if (event === 'USER_UPDATED' && session?.user) {
        // e.g. the password was changed: pick up the new metadata without refetching the profile
        const must = session.user.user_metadata?.must_change_password === true;
        setUser(prev => (prev ? { ...prev, mustChangePassword: must } : prev));
      }
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const login = async (identifier, password) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginIdToEmail(identifier),
        password,
      });
      if (error) {
        if (error.status === 429) return { success: false, error: 'Too many attempts. Please wait a minute and try again.' };
        return { success: false, error: 'Invalid credentials' };
      }
      const profile = await loadProfile(data.user);
      if (!profile) {
        await supabase.auth.signOut();
        return { success: false, error: 'Account is not set up. Contact the office.' };
      }
      return { success: true };
    } catch (error) {
      console.error('Login error:', error);
      return { success: false, error: 'Connection error' };
    }
  };

  // Re-verifies the current password, then sets the new one and clears the
  // "temporary password" flag set by admin resets.
  const changePassword = async (currentPassword, newPassword) => {
    if (!user) return { success: false, error: 'Not signed in' };
    if (newPassword.length < 8) return { success: false, error: 'Password must be at least 8 characters' };
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: user.loginEmail || loginIdToEmail(user.username),
      password: currentPassword,
    });
    if (verifyError) {
      return { success: false, error: verifyError.status === 429 ? 'Too many attempts. Please wait a minute.' : 'Current password is incorrect' };
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword, data: { must_change_password: false } });
    if (error) return { success: false, error: error.message };
    setUser(prev => (prev ? { ...prev, mustChangePassword: false } : prev));
    return { success: true };
  };

  // Invite / reset links sign the person in without a password, so there is no "current password" to check.
  const setInitialPassword = async (newPassword) => {
    if (newPassword.length < 8) return { success: false, error: 'Password must be at least 8 characters' };
    const { error } = await supabase.auth.updateUser({ password: newPassword, data: { must_change_password: false } });
    if (error) return { success: false, error: error.message };
    setPasswordSetup(false);
    setUser(prev => (prev ? { ...prev, mustChangePassword: false } : prev));
    return { success: true };
  };

  // Always reports success for unknown addresses so the form can't be used to discover who has an account.
  const requestPasswordReset = async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), {
      redirectTo: window.location.origin,
    });
    if (error && error.status === 429) return { success: false, error: 'Too many requests. Please wait a few minutes and try again.' };
    return { success: true };
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  const value = {
    user,
    login,
    logout,
    changePassword,
    setInitialPassword,
    requestPasswordReset,
    passwordSetup,
    linkError: initialLink.error,
    loading
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};