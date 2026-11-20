import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useData } from '../../context/DataContext';
import { useAuth } from '../../context/AuthContext';
import { isValidEmail } from '../../lib/authEmail';
import { ASSIGNABLE_ROLES, roleLabel } from '../../lib/roles';
import SafeIcon from '../../common/SafeIcon';
import * as FiIcons from 'react-icons/fi';

const { FiPlus, FiEdit, FiTrash2, FiUser, FiEye, FiEyeOff, FiCheck, FiAlertCircle, FiSend } = FiIcons;

const UserManagement = () => {
  const { users, addUser, updateUser, deleteUser, resendInvite } = useData();
  const { user: me } = useAuth();
  const [showSalesmanForm, setShowSalesmanForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [showPassword, setShowPassword] = useState({});
  const [sendInvite, setSendInvite] = useState(true); // new people get an email to set their own password
  const [notification, setNotification] = useState(null);
  const [salesmanForm, setSalesmanForm] = useState({
    name: '',
    password: '',
    confirmPassword: '',
    email: '',
    phone: '',
    role: 'salesman'
  });

  const accounts = users;

  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const handleSalesmanSubmit = async (e) => {
    e.preventDefault();

    const passwordChanging = editingUser ? !!salesmanForm.password : !sendInvite;
    if (passwordChanging) {
      if (salesmanForm.password !== salesmanForm.confirmPassword) {
        showNotification('Passwords do not match', 'error');
        return;
      }
      if (salesmanForm.password.length < 8) {
        showNotification('Password must be at least 8 characters', 'error');
        return;
      }
    }

    const email = salesmanForm.email.trim().toLowerCase();
    if (!isValidEmail(email)) {
      showNotification('Enter a valid email address', 'error');
      return;
    }
    // Each email can only belong to one account
    if (users.some(user => user.id !== editingUser?.id && user.email?.toLowerCase() === email)) {
      showNotification('Another account already uses that email', 'error');
      return;
    }

    const userData = {
      name: salesmanForm.name,
      email,
      phone: salesmanForm.phone,
      role: salesmanForm.role,
      password: salesmanForm.password,
      invite: !editingUser && sendInvite,
      redirectTo: window.location.origin
    };

    try {
      if (editingUser) {
        await updateUser(editingUser.id, userData);
        showNotification('User updated successfully', 'success');
      } else {
        await addUser(userData);
        showNotification(sendInvite ? `Invite sent to ${email}` : 'User added successfully', 'success');
      }
      resetSalesmanForm();
    } catch (err) {
      showNotification(err.message || 'Failed to save user', 'error');
    }
  };

  const resetSalesmanForm = () => {
    setSalesmanForm({
      name: '',
      password: '',
      confirmPassword: '',
      email: '',
      phone: '',
      role: 'salesman'
    });
    setShowSalesmanForm(false);
    setEditingUser(null);
  };

  const handleEditSalesman = (user) => {
    setSalesmanForm({
      name: user.name,
      email: user.email || '',
      phone: user.phone || '',
      password: '',
      confirmPassword: '',
      role: user.role
    });
    setEditingUser(user);
    setShowSalesmanForm(true);
  };

  const handleResendInvite = async (account) => {
    try {
      await resendInvite(account.id);
      showNotification(`Invite re-sent to ${account.email}`, 'success');
    } catch (err) {
      showNotification(err.message || 'Could not send the invite', 'error');
    }
  };

  const handleDeleteSalesman = async (user) => {
    if (window.confirm(`Are you sure you want to delete ${user.name}? This action cannot be undone.`)) {
      try {
        await deleteUser(user.id);
        showNotification('User deleted successfully', 'success');
      } catch (err) {
        showNotification(err.message || 'Failed to delete user', 'error');
      }
    }
  };

  const togglePasswordVisibility = (field) => {
    setShowPassword(prev => ({
      ...prev,
      [field]: !prev[field]
    }));
  };

  if (!me?.isOwner) {
    return <p className="text-sm text-gray-600">Only the main admin can manage users.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center space-x-3">
        <SafeIcon icon={FiUser} className="text-2xl text-gray-700" />
        <h2 className="text-2xl font-title font-bold text-gray-900">User Management</h2>
      </div>

      {/* Notification */}
      {notification && (
        <motion.div 
          initial={{ opacity: 0, y: -20 }} 
          animate={{ opacity: 1, y: 0 }} 
          exit={{ opacity: 0, y: -20 }}
          className={`p-4 rounded-lg flex items-center space-x-2 ${
            notification.type === 'success' 
              ? 'bg-green-50 text-green-800 border border-green-200' 
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          <SafeIcon icon={notification.type === 'success' ? FiCheck : FiAlertCircle} />
          <span>{notification.message}</span>
        </motion.div>
      )}

      {/* Salesmen Management */}
      <motion.div 
        initial={{ opacity: 0, y: 20 }} 
        animate={{ opacity: 1, y: 0 }} 
        transition={{ delay: 0.1 }}
        className="bg-white rounded-xl shadow-lg"
      >
        <div className="p-6 border-b border-gray-200">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-title font-semibold text-gray-900">Accounts</h3>
            <button 
              onClick={() => setShowSalesmanForm(true)}
              className="flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              <SafeIcon icon={FiPlus} />
              <span>Add User</span>
            </button>
          </div>
        </div>

        {/* Salesman Form */}
        {showSalesmanForm && (
          <motion.div 
            initial={{ opacity: 0, height: 0 }} 
            animate={{ opacity: 1, height: 'auto' }} 
            exit={{ opacity: 0, height: 0 }}
            className="border-b border-gray-200"
          >
            <form onSubmit={handleSalesmanSubmit} className="p-6 space-y-6">
              <h4 className="text-md font-semibold text-gray-900">
                {editingUser ? 'Edit User' : 'Add New User'}
              </h4>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Email (used to sign in) *</label>
                  <input 
                    type="email" 
                    value={salesmanForm.email}
                    onChange={(e) => setSalesmanForm(prev => ({ ...prev, email: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Full Name *</label>
                  <input 
                    type="text" 
                    value={salesmanForm.name}
                    onChange={(e) => setSalesmanForm(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Access level *</label>
                  <select
                    value={salesmanForm.role}
                    onChange={(e) => setSalesmanForm(prev => ({ ...prev, role: e.target.value }))}
                    disabled={!!editingUser && (editingUser.role === 'owner' || editingUser.id === me?.id)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent disabled:bg-gray-100"
                  >
                    {editingUser?.role === 'owner' && <option value="owner">{roleLabel('owner')}</option>}
                    {ASSIGNABLE_ROLES.map(r => <option key={r} value={r}>{roleLabel(r)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Phone</label>
                  <input 
                    type="tel" 
                    value={salesmanForm.phone}
                    onChange={(e) => setSalesmanForm(prev => ({ ...prev, phone: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>
                {!editingUser && (
                  <label className="md:col-span-2 flex items-start space-x-3 text-sm text-gray-700">
                    <input type="checkbox" className="mt-1" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} />
                    <span>
                      <strong>Email an invite</strong> so they choose their own password.
                      <span className="block text-xs text-gray-500">Untick to set a temporary password yourself instead.</span>
                    </span>
                  </label>
                )}
                {(editingUser || !sendInvite) && (
                <>
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Password {editingUser && '(Leave blank to keep current)'}
                  </label>
                  <input 
                    type={showPassword.password ? 'text' : 'password'} 
                    value={salesmanForm.password}
                    onChange={(e) => setSalesmanForm(prev => ({ ...prev, password: e.target.value }))}
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    required={!editingUser}
                    minLength={6}
                  />
                  <button 
                    type="button"
                    onClick={() => togglePasswordVisibility('password')}
                    className="absolute right-3 top-9 text-gray-400 hover:text-gray-600"
                  >
                    <SafeIcon icon={showPassword.password ? FiEyeOff : FiEye} />
                  </button>
                </div>
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Confirm Password</label>
                  <input 
                    type={showPassword.confirmPassword ? 'text' : 'password'} 
                    value={salesmanForm.confirmPassword}
                    onChange={(e) => setSalesmanForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
                    required={!editingUser || salesmanForm.password}
                  />
                  <button 
                    type="button"
                    onClick={() => togglePasswordVisibility('confirmPassword')}
                    className="absolute right-3 top-9 text-gray-400 hover:text-gray-600"
                  >
                    <SafeIcon icon={showPassword.confirmPassword ? FiEyeOff : FiEye} />
                  </button>
                </div>
                </>
                )}
              </div>

              <div className="flex justify-end space-x-4">
                <button 
                  type="button" 
                  onClick={resetSalesmanForm}
                  className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                >
                  {editingUser ? 'Update User' : 'Add User'}
                </button>
              </div>
            </form>
          </motion.div>
        )}

        {/* Salesmen List */}
        <div className="p-6">
          {accounts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {accounts.map((salesman, index) => (
                <motion.div 
                  key={salesman.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.1 }}
                  className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
                        <SafeIcon icon={FiUser} className="text-red-600" />
                      </div>
                      <div>
                        <h4 className="font-semibold text-gray-900">{salesman.name}</h4>
                        <p className="text-sm text-gray-500">
                          {salesman.email || salesman.username}
                          <span className="ml-2 text-[10px] uppercase tracking-wide bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{roleLabel(salesman.role)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      {salesman.id !== me?.id && salesman.role !== 'owner' && (
                      <button 
                        onClick={() => handleResendInvite(salesman)}
                        className="text-gray-500 hover:text-gray-800"
                        title="Re-send invite email"
                      >
                        <SafeIcon icon={FiSend} />
                      </button>
                      )}
                      <button 
                        onClick={() => handleEditSalesman(salesman)}
                        className="text-blue-600 hover:text-blue-800"
                        title="Edit"
                      >
                        <SafeIcon icon={FiEdit} />
                      </button>
                      {salesman.id !== me?.id && salesman.role !== 'owner' && (
                      <button 
                        onClick={() => handleDeleteSalesman(salesman)}
                        className="text-red-600 hover:text-red-800"
                        title="Delete"
                      >
                        <SafeIcon icon={FiTrash2} />
                      </button>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-1 text-sm text-gray-600">
                    {salesman.email && (
                      <div><strong>Email:</strong> {salesman.email}</div>
                    )}
                    {salesman.phone && (
                      <div><strong>Phone:</strong> {salesman.phone}</div>
                    )}
                    <div className="text-xs text-gray-400 mt-2">
                      Last updated: {new Date(salesman.updated_at || salesman.created_at).toLocaleDateString()}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <SafeIcon icon={FiUser} className="text-4xl text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">No users yet</p>
              <button 
                onClick={() => setShowSalesmanForm(true)}
                className="mt-4 text-red-600 hover:text-red-700 font-medium"
              >
                Add your first user
              </button>
            </div>
          )}
        </div>
      </motion.div>

    </div>
  );
};

export default UserManagement;