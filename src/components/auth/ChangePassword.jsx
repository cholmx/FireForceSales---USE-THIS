import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';

// Used as a modal from the header, or as a blocking screen (forced) after an admin-set temporary password.
const ChangePassword = ({ forced = false, onClose }) => {
  const { changePassword, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) return setError('New passwords do not match');
    if (next === current) return setError('Choose a password different from the current one');
    setSaving(true);
    const result = await changePassword(current, next);
    setSaving(false);
    if (!result.success) return setError(result.error);
    setDone(true);
    if (!forced) setTimeout(() => onClose?.(), 1200);
  };

  const field = 'w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 focus:bg-white focus:ring-1 focus:ring-red-500 focus:border-red-500';
  const label = 'block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1.5';

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 ${forced ? 'bg-[#f8f9fa]' : 'bg-gray-900/50 backdrop-blur-sm'}`}>
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-xl shadow-xl border border-gray-100 p-6 max-w-sm w-full space-y-4"
      >
        <div>
          <h3 className="text-base font-bold text-gray-900">{forced ? 'Choose a new password' : 'Change password'}</h3>
          {forced && <p className="text-xs text-gray-500 mt-1">Your password was set by an administrator. Please choose your own to continue.</p>}
        </div>
        {error && <div role="alert" className="bg-red-50 text-red-600 text-xs p-3 rounded-lg border border-red-100">{error}</div>}
        {done && <div role="status" className="bg-green-50 text-green-700 text-xs p-3 rounded-lg border border-green-100">Password updated.</div>}
        <div>
          <label className={label} htmlFor="cp-current">Current password</label>
          <input id="cp-current" type="password" autoComplete="current-password" required className={field} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="cp-new">New password (8+ characters)</label>
          <input id="cp-new" type="password" autoComplete="new-password" required minLength={8} className={field} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="cp-confirm">Confirm new password</label>
          <input id="cp-confirm" type="password" autoComplete="new-password" required minLength={8} className={field} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="flex justify-end space-x-3 pt-1">
          {forced ? (
            <button type="button" onClick={logout} className="px-4 py-2 border border-gray-200 rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50">Sign out</button>
          ) : (
            <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-200 rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50">Cancel</button>
          )}
          <button type="submit" disabled={saving || done} className="px-4 py-2 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700 disabled:opacity-60">
            {saving ? 'Saving...' : 'Update password'}
          </button>
        </div>
      </motion.form>
    </div>
  );
};

export default ChangePassword;
