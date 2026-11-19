import React, { createContext, useContext, useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import supabase from '../lib/supabase';
import { useAuth } from './AuthContext';

const DataContext = createContext();

export const useData = () => {
  const context = useContext(DataContext);
  if (!context) throw new Error('useData must be used within a DataProvider');
  return context;
};

export const DataProvider = ({ children }) => {
  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [users, setUsers] = useState([]);
  const [officeInfo, setOfficeInfo] = useState({});
  const [settings, setSettings] = useState({ taxRate: 8.0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const { user: authUser } = useAuth();

  useEffect(() => {
    if (authUser) {
      loadAllData();
    } else {
      setInvoices([]); setCustomers([]); setUsers([]); setOfficeInfo({});
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser?.id]);

  const loadAllData = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      await Promise.all([
        loadInvoices(),
        loadCustomers(),
        loadUsers(),
        loadOfficeInfo(),
        loadSettings(),
      ]);
    } catch (error) {
      console.error('Error loading data from Supabase:', error);
      setLoadError(error.message || 'Could not load data');
    } finally {
      setLoading(false);
    }
  };

  // PostgREST caps a response at 1000 rows by default; page through everything.
  const fetchAll = async (buildQuery, pageSize = 1000) => {
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await buildQuery().range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < pageSize) return rows;
    }
  };

  const loadInvoices = async () => {
    const data = await fetchAll(() => supabase
      .from('invoices_ff2024')
      .select(`*, invoice_items_ff2024 (*)`)
      .order('created_at', { ascending: false })
      .order('id'));
    const formatted = data.map(invoice => ({
      ...invoice,
      poNumber: invoice.po_number,
      salesRep: invoice.sales_rep,
      salesRepId: invoice.sales_rep_id,
      transactionType: invoice.transaction_type,
      customerName: invoice.customer_name,
      company: invoice.company,
      customerEmail: invoice.customer_email,
      customerPhone: invoice.customer_phone,
      accountsPayableEmail: invoice.accounts_payable_email,
      billToAddress: invoice.bill_to_address,
      shipToAddress: invoice.ship_to_address,
      shippingCost: parseFloat(invoice.shipping_cost) || 0,
      additionalInfo: invoice.additional_info,
      taxRate: parseFloat(invoice.tax_rate) || 8.0,
      subtotal: parseFloat(invoice.subtotal) || 0,
      tax: parseFloat(invoice.tax) || 0,
      grandTotal: parseFloat(invoice.grand_total) || 0,
      createdAt: invoice.created_at,
      updatedAt: invoice.updated_at,
      archived: invoice.archived || false,
      items: invoice.invoice_items_ff2024.map(item => ({
        mfg: item.mfg,
        partNumber: item.part_number,
        description: item.description,
        qty: item.qty,
        unitPrice: parseFloat(item.unit_price),
        taxable: item.taxable,
      })),
    }));
    setInvoices(formatted);
    return formatted;
  };

  const loadCustomers = async () => {
    const data = await fetchAll(() => supabase
      .from('customers_ff2024')
      .select('*')
      .order('name')
      .order('id'));
    const formatted = data.map(customer => ({
      ...customer,
      company: customer.company || '',
      billToAddress: customer.bill_to_address,
      shipToAddress: customer.ship_to_address,
      accountsPayableEmail: customer.accounts_payable_email,
    }));
    setCustomers(formatted);
    return formatted;
  };

  const loadUsers = async () => {
    const { data, error } = await supabase
      .from('users_ff2024')
      .select('id, username, name, email, phone, role, created_at, updated_at')
      .order('name');
    if (error) throw error;
    setUsers(data);
    return data;
  };

  const loadOfficeInfo = async () => {
    const { data, error } = await supabase
      .from('office_info_ff2024')
      .select('*')
      .limit(1)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    if (data) {
      const formatted = {
        companyName: data.company_name,
        address: data.address,
        phone: data.phone,
        emergencyPhone: data.emergency_phone,
        email: data.email,
        serviceEmail: data.service_email,
      };
      setOfficeInfo(formatted);
      return formatted;
    }
    return {};
  };

  const loadSettings = async () => {
    const { data, error } = await supabase
      .from('settings_ff2024')
      .select('*');
    // If error or empty, fall back to default
    if (error || !data || data.length === 0) {
      console.warn('Settings not found, using defaults');
      setSettings({ taxRate: 8.0 });
      return { taxRate: 8.0 };
    }
    const settingsObj = {};
    data.forEach(setting => {
      if (setting.key === 'tax_rate') {
        settingsObj.taxRate = parseFloat(setting.value);
      }
    });
    const final = settingsObj.taxRate !== undefined ? settingsObj : { taxRate: 8.0 };
    setSettings(final);
    return final;
  };

  // ─── Invoice Operations ───────────────────────────────────────────────────

  const toRpcPayload = (inv) => ({
    id: inv.id,
    date: inv.date,
    poNumber: inv.poNumber,
    salesRepId: inv.salesRepId,
    transactionType: inv.transactionType,
    customerName: inv.customerName,
    company: inv.company,
    customerEmail: inv.customerEmail,
    customerPhone: inv.customerPhone,
    accountsPayableEmail: inv.accountsPayableEmail,
    billToAddress: inv.billToAddress,
    shipToAddress: inv.shipToAddress,
    shippingCost: inv.shippingCost,
    additionalInfo: inv.additionalInfo,
    status: inv.status,
    taxRate: inv.taxRate,
  });

  // Invoice + line items are saved in one database transaction; the server
  // recomputes subtotal/tax/total from the items.
  const saveInvoice = async (invoice) => {
    const { data, error } = await supabase.rpc('save_invoice', {
      p_invoice: toRpcPayload(invoice),
      p_items: (invoice.items || []).map(item => ({
        mfg: item.mfg,
        partNumber: item.partNumber,
        description: item.description,
        qty: item.qty,
        unitPrice: item.unitPrice,
        taxable: item.taxable,
      })),
    });
    if (error) throw error;
    await loadInvoices();
    return data;
  };

  const addInvoice = async (invoiceData) => {
    const id = await saveInvoice({ ...invoiceData, id: undefined });
    return { ...invoiceData, id };
  };

  const updateInvoice = async (id, updates) => {
    if (updates.items) {
      const existing = invoices.find(inv => inv.id === id) || {};
      await saveInvoice({ ...existing, ...updates, id });
      return;
    }
    // Field-only updates (archive toggle, status) don't touch line items.
    const map = { status: 'status', archived: 'archived' };
    const updateData = {};
    Object.entries(map).forEach(([k, col]) => { if (updates[k] !== undefined) updateData[col] = updates[k]; });
    const { error } = await supabase.from('invoices_ff2024').update(updateData).eq('id', id);
    if (error) throw error;
    await loadInvoices();
  };

  const deleteInvoice = async (id) => {
    const { error } = await supabase.rpc('delete_invoice', { p_id: id });
    if (error) throw error;
    setInvoices(prev => prev.filter(inv => inv.id !== id));
  };

  // ─── Customer Operations ──────────────────────────────────────────────────

  const addCustomer = async (customerData) => {
    const { data, error } = await supabase
      .from('customers_ff2024')
      .insert([{
        name: customerData.name,
        company: customerData.company || '',
        email: customerData.email,
        phone: customerData.phone,
        bill_to_address: customerData.billToAddress,
        ship_to_address: customerData.shipToAddress,
        accounts_payable_email: customerData.accountsPayableEmail,
      }])
      .select()
      .single();
    if (error) throw error;
    await loadCustomers();
    return data;
  };

  const updateCustomer = async (id, updates) => {
    const { error } = await supabase
      .from('customers_ff2024')
      .update({
        name: updates.name,
        company: updates.company || '',
        email: updates.email,
        phone: updates.phone,
        bill_to_address: updates.billToAddress,
        ship_to_address: updates.shipToAddress,
        accounts_payable_email: updates.accountsPayableEmail,
      })
      .eq('id', id);
    if (error) throw error;
    await loadCustomers();
  };

  const deleteCustomer = async (id) => {
    const { error } = await supabase
      .from('customers_ff2024')
      .delete()
      .eq('id', id);
    if (error) throw error;
    setCustomers(prev => prev.filter(c => c.id !== id));
  };

  // ─── User Operations ──────────────────────────────────────────────────────

  const callManageUsers = async (payload) => {
    const { data, error } = await supabase.functions.invoke('manage-users', { body: payload });
    if (error) {
      let msg = error.message;
      try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  };

  const addUser = async (userData) => {
    const data = await callManageUsers({
      action: 'create',
      role: userData.role,
      username: userData.username,
      name: userData.name,
      email: userData.email,
      phone: userData.phone,
      password: userData.password,
    });
    await loadUsers();
    return data.user;
  };

  const updateUser = async (id, updates) => {
    await callManageUsers({
      action: 'update',
      id,
      name: updates.name,
      email: updates.email,
      phone: updates.phone,
      password: updates.password || undefined,
    });
    await loadUsers();
  };

  const deleteUser = async (id) => {
    await callManageUsers({ action: 'delete', id });
    await loadUsers();
  };

  // ─── Settings Operations ──────────────────────────────────────────────────

  const updateSettings = async (newSettings) => {
    try {
      if (newSettings.taxRate !== undefined) {
        const taxRateValue = parseFloat(newSettings.taxRate).toString();
        const { error } = await supabase
          .from('settings_ff2024')
          .upsert([{ key: 'tax_rate', value: taxRateValue }], { onConflict: 'key' });
        if (error) throw error;
        setSettings(prev => ({ ...prev, taxRate: parseFloat(newSettings.taxRate) }));
      }
      await loadSettings();
    } catch (error) {
      console.error('Error updating settings:', error);
      throw error;
    }
  };

  // ─── Office Info Operations ───────────────────────────────────────────────

  const updateOfficeInfo = async (updates) => {
    const updateData = {
      company_name: updates.companyName,
      address: updates.address,
      phone: updates.phone,
      emergency_phone: updates.emergencyPhone,
      email: updates.email,
      service_email: updates.serviceEmail,
    };

    const { data: checkData, error: checkError } = await supabase
      .from('office_info_ff2024')
      .select('id')
      .limit(1);
    if (checkError) throw checkError;

    let result;
    if (checkData && checkData.length > 0) {
      result = await supabase
        .from('office_info_ff2024')
        .update(updateData)
        .eq('id', checkData[0].id);
    } else {
      result = await supabase
        .from('office_info_ff2024')
        .insert([updateData]);
    }
    if (result.error) throw result.error;

    setOfficeInfo({
      companyName: updates.companyName,
      address: updates.address,
      phone: updates.phone,
      emergencyPhone: updates.emergencyPhone,
      email: updates.email,
      serviceEmail: updates.serviceEmail,
    });
    await loadOfficeInfo();
  };

  const value = {
    invoices, customers, users, officeInfo, settings, loading, loadError,
    addInvoice, updateInvoice, deleteInvoice,
    addCustomer, updateCustomer, deleteCustomer,
    addUser, updateUser, deleteUser,
    updateOfficeInfo, updateSettings, loadAllData,
  };

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
};