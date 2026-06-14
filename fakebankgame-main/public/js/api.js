// ============================================================
// public/js/api.js
// Module central fetch -> API backend.
// Expose window.API avec toutes les methodes.
// ============================================================
(function () {
  'use strict';

  function buildQuery(params) {
    if (!params || typeof params !== 'object') return '';
    const entries = Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (!entries.length) return '';
    return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }

  async function request(method, url, body) {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body !== undefined && body !== null && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (_) {
      return { data: null, error: 'Erreur réseau : impossible de joindre le serveur.', status: 0 };
    }

    if (response.status === 401) {
      const authPages = ['/login.html', '/register.html', '/index.html', '/'];
      const cur = window.location.pathname;
      if (!authPages.some(p => cur.endsWith(p))) {
        window.location.href = '/login.html?redirect=' + encodeURIComponent(cur + window.location.search);
        return { data: null, error: 'Session expirée.', status: 401 };
      }
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}

    if (!response.ok) {
      return { data: null, error: (data && (data.error || data.message)) || `Erreur ${response.status}`, status: response.status };
    }
    return { data, error: null, status: response.status };
  }

  const API = {};

  API.auth = {
    me()                      { return request('GET',  '/api/auth/me'); },
    login(identifier, password) { return request('POST', '/api/auth/login', { identifier, password }); },
    register(data)            { return request('POST', '/api/auth/register', data); },
    logout()                  { return request('POST', '/api/auth/logout'); },
    changePassword(cur, np, cnp) { return request('POST', '/api/auth/change-password', { currentPassword:cur, newPassword:np, confirmNewPassword:cnp }); },
  };

  API.account = {
    get()                   { return request('GET',  '/api/account'); },
    getBalance()            { return request('GET',  '/api/account/balance'); },
    getProfile()            { return request('GET',  '/api/account/profile'); },
    updateProfile(data)     { return request('PUT',  '/api/account/profile', data); },
    getNotifications(p)     { return request('GET',  '/api/account/notifications' + buildQuery(p)); },
    markRead(id)            { return request('POST', `/api/account/notifications/${id}/read`); },
    markAllRead()           { return request('POST', '/api/account/notifications/read-all'); },
  };

  API.transactions = {
    transfer(data)      { return request('POST', '/api/transactions/transfer', data); },
    getHistory(p)       { return request('GET',  '/api/transactions/history' + buildQuery(p)); },
    getSummary(days)    { return request('GET',  '/api/transactions/summary' + buildQuery({ days })); },
    getById(id)         { return request('GET',  `/api/transactions/${id}`); },
  };

  API.users = {
    search(q)     { return request('GET', '/api/users/search' + buildQuery({ q })); },
    lookup(iban)  { return request('GET', '/api/users/lookup' + buildQuery({ iban })); },
  };

  API.tpe = {
    request(data)       { return request('POST', '/api/tpe/request', data); },
    getPayment(uuid)    { return request('GET',  `/api/tpe/pay/${uuid}`); },
    pay(uuid)           { return request('POST', `/api/tpe/pay/${uuid}`); },
    cancel(uuid)        { return request('POST', `/api/tpe/cancel/${uuid}`); },
    getHistory(p)       { return request('GET',  '/api/tpe/history' + buildQuery(p)); },
    getPending()        { return request('GET',  '/api/tpe/pending'); },
  };

  API.employee = {
    getAccounts(p)          { return request('GET',  '/api/employee/accounts' + buildQuery(p)); },
    getAccount(id)          { return request('GET',  `/api/employee/accounts/${id}`); },
    getTransactions(id, p)  { return request('GET',  `/api/employee/accounts/${id}/transactions` + buildQuery(p)); },
    credit(id, data)        { return request('POST', `/api/employee/accounts/${id}/credit`, data); },
    debit(id, data)         { return request('POST', `/api/employee/accounts/${id}/debit`, data); },
    getRequests(p)          { return request('GET',  '/api/employee/requests' + buildQuery(p)); },
    updateRequest(id, data) { return request('PUT',  `/api/employee/requests/${id}`, data); },
  };

  API.requests = {
    create(data) { return request('POST', '/api/requests', data); },
    getMine()    { return request('GET',  '/api/requests/mine'); },
  };

  API.admin = {
    getUsers(p)         { return request('GET',    '/api/admin/users' + buildQuery(p)); },
    getUser(id)         { return request('GET',    `/api/admin/users/${id}`); },
    createUser(data)    { return request('POST',   '/api/admin/users', data); },
    deleteUser(id)      { return request('DELETE', `/api/admin/users/${id}`); },
    setRole(id, role)   { return request('PUT',    `/api/admin/users/${id}/role`, { role }); },
    setTpe(id, hasTpe, tpeLabel) { return request('PUT', `/api/admin/users/${id}/tpe`, { hasTpe, tpeLabel }); },
    setStatus(id, isActive) { return request('PUT', `/api/admin/users/${id}/status`, { isActive }); },
    freezeAccount(uid, isFrozen) { return request('PUT', `/api/admin/accounts/${uid}/freeze`, { isFrozen }); },
    adjustBalance(uid, data) { return request('POST', `/api/admin/accounts/${uid}/adjust`, data); },
    getTransactions(p)  { return request('GET', '/api/admin/transactions' + buildQuery(p)); },
    getLogs(p)          { return request('GET', '/api/admin/logs' + buildQuery(p)); },
    getBanks()          { return request('GET', '/api/admin/banks'); },
    createBank(data)    { return request('POST', '/api/admin/banks', data); },
    getStats()          { return request('GET', '/api/admin/stats'); },
  };

  window.API = API;
})();