import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';

// Shown after someone follows an invite or password-reset email link.
const SetPassword = () => {
  const { user, setInitialPassword, logout } = useAuth();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) return setError('Passwords do not match');
    setSaving(true);
    const result = await setInitialPassword(next);
    setSaving(false);
    if (!result.success) setError(result.error);
  };

  const field = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 focus:bg-white focus:ring-1 focus:ring-red-500 focus:border-red-500';
  const label = 'block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1.5';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#f8f9fa]">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-xl shadow-xl border border-gray-100 p-6 max-w-sm w-full space-y-4"
      >
        <div>
          <h3 className="text-base font-bold text-gray-900">Set your password</h3>
          <p className="text-xs text-gray-500 mt-1">Welcome{user?.name ? `, ${user.name}` : ''}. Choose a password to finish setting up your account.</p>
        </div>
        {error && <div role="alert" className="bg-red-50 text-red-600 text-xs p-3 rounded-lg border border-red-100">{error}</div>}
        <div>
          <label className={label} htmlFor="sp-new">New password (8+ characters)</label>
          <input id="sp-new" type="password" autoComplete="new-password" required minLength={8} className={field} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="sp-confirm">Confirm password</label>
          <input id="sp-confirm" type="password" autoComplete="new-password" required minLength={8} className={field} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="flex justify-end space-x-3 pt-1">
          <button type="button" onClick={logout} className="px-4 py-2 border border-gray-200 rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50">Sign out</button>
          <button type="submit" disabled={saving} className="px-4 py-2 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700 disabled:opacity-60">
            {saving ? 'Saving...' : 'Save password'}
          </button>
        </div>
      </motion.form>
    </div>
  );
};

export default SetPassword;
