import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';
import SafeIcon from '../../common/SafeIcon';
import * as FiIcons from 'react-icons/fi';

const { FiUser, FiLock, FiAlertCircle, FiEye, FiEyeOff } = FiIcons;

const Login = () => {
  const { login, requestPasswordReset, linkError } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(linkError || '');
  const [mode, setMode] = useState('login'); // 'login' | 'reset'
  const [resetSent, setResetSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(identifier, password);
      if (!result.success) {
        setError(result.error || 'Invalid email or password');
      }
    } catch (error) {
      setError('An error occurred. Please try again.');
      console.error('Login error:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await requestPasswordReset(identifier);
    setLoading(false);
    if (!result.success) return setError(result.error);
    setResetSent(true);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8f9fa]">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="max-w-sm w-full mx-4"
      >
        <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-gray-100 p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-brand-gradient rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-orange-500/20">
              <span className="text-white font-title font-bold text-xl">FF</span>
            </div>
            <h1 className="text-2xl font-title font-bold text-gray-900 mb-1">Fire Force</h1>
            <p className="text-xs text-gray-500 uppercase tracking-widest font-medium">Invoice Management</p>
          </div>

          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="bg-red-50 text-red-600 text-xs p-3 rounded-lg flex items-center space-x-2 mb-6 border border-red-100"
            >
              <SafeIcon icon={FiAlertCircle} className="flex-shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}

          {mode === 'reset' ? (
            resetSent ? (
              <div className="space-y-4 text-sm text-gray-600">
                <p>If that email belongs to an account, we've sent a link to set a new password. Check your inbox (and spam).</p>
                <button type="button" onClick={() => { setMode('login'); setResetSent(false); }} className="text-xs font-semibold text-red-600 hover:text-red-700">Back to sign in</button>
              </div>
            ) : (
              <form onSubmit={handleReset} className="space-y-5">
                <p className="text-sm text-gray-600">Enter your email and we'll send you a link to set a new password.</p>
                <input
                  type="email"
                  autoComplete="email"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm bg-gray-50 focus:bg-white"
                  placeholder="you@example.com"
                  required
                />
                <button type="submit" disabled={loading} className="w-full bg-brand-gradient text-white py-2.5 rounded-lg text-sm font-semibold disabled:opacity-70">
                  {loading ? 'Sending...' : 'Send reset link'}
                </button>
                <button type="button" onClick={() => setMode('login')} className="block mx-auto text-xs font-semibold text-gray-500 hover:text-gray-700">Back to sign in</button>
              </form>
            )
          ) : (
            <>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Email</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <SafeIcon icon={FiUser} className="text-gray-400 text-sm" />
                </div>
                <input
                  type="text"
                  inputMode="email"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="pl-9 w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-gradient-start/20 focus:border-gradient-start transition-all duration-200 placeholder-gray-400 bg-gray-50 focus:bg-white"
                  placeholder="you@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 uppercase tracking-wide">Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <SafeIcon icon={FiLock} className="text-gray-400 text-sm" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-9 w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-gradient-start/20 focus:border-gradient-start transition-all duration-200 placeholder-gray-400 bg-gray-50 focus:bg-white"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                >
                  <SafeIcon icon={showPassword ? FiEyeOff : FiEye} className="text-gray-400 hover:text-gray-600 text-sm" />
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-brand-gradient hover:bg-brand-gradient-hover text-white py-2.5 rounded-lg text-sm font-semibold shadow-md shadow-orange-500/20 hover:shadow-lg hover:shadow-orange-500/30 transform active:scale-[0.98] transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing In...' : 'Sign In'}
            </button>
          </form>
              <button type="button" onClick={() => { setError(''); setMode('reset'); }} className="block mx-auto mt-4 text-xs font-semibold text-gray-500 hover:text-red-600">
                Forgot password?
              </button>
            </>
          )}
        </div>
        <p className="text-center text-xs text-gray-400 mt-6">
          &copy; {new Date().getFullYear()} Fire Force Safety. All rights reserved.
        </p>
      </motion.div>
    </div>
  );
};

export default Login;