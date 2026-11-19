import React, { createContext, useContext, useState, useEffect } from 'react';
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

  const loadProfile = async (authUser) => {
    if (!authUser) { setUser(null); return null; }
    const { data, error } = await supabase
      .from('users_ff2024')
      .select('id, username, name, role')
      .eq('auth_id', authUser.id)
      .maybeSingle();
    if (error || !data) { setUser(null); return null; }
    setUser(data);
    return data;
  };

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (active) await loadProfile(data.session?.user ?? null);
      if (active) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') setUser(null);
      // defer to avoid deadlocking inside the auth callback
      else if (event === 'SIGNED_IN') setTimeout(() => active && loadProfile(session?.user ?? null), 0);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  const login = async (username, password) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: usernameToEmail(username),
        password,
      });
      if (error) return { success: false, error: 'Invalid credentials' };
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

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  const value = {
    user,
    login,
    logout,
    loading
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};