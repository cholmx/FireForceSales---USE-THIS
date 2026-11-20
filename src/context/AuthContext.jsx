import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import supabase from '../lib/supabase';
import { usernameToEmail } from '../lib/authEmail';

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
    const profile = { ...data, mustChangePassword: authUser.user_metadata?.must_change_password === true };
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
      if (event === 'SIGNED_OUT') {
        loadedAuthId.current = null;
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

  const login = async (username, password) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: usernameToEmail(username),
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
      email: usernameToEmail(user.username),
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

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  const value = {
    user,
    login,
    logout,
    changePassword,
    loading
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};