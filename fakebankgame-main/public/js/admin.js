// ============================================================
// public/js/admin.js
// Interface administration — tableau de bord admin complet
// ============================================================

(function () {
  'use strict';

  let currentTab = 'users';

  // ----------------------------------------------------------
  // Formatage
  // ----------------------------------------------------------
  function formatMoney(cents) {
    return (cents / 100).toLocaleString('fr-FR', {
      style:    'currency',
      currency: 'EUR',
    });
  }

  function formatDate(dateStr) {
    return new Date(dateStr).toLocaleString('fr-FR');
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ----------------------------------------------------------
  // Vérification accès admin
  // ----------------------------------------------------------
  async function checkAdmin() {
    const res = await window.API.auth.me();
    if (res.error || !res.data) {
      window.location.href = '/login.html';
      return null;
    }
    const user = res.data.user;
    if (user.role !== 'admin') {
      window.location.href = '/dashboard.html';
      return null;
    }
    return user;
  }

  // ----------------------------------------------------------
  // Chargement des stats
  // ----------------------------------------------------------
  async function loadStats() {
    const res = await window.API.admin.getStats();
    if (res.error) return;

    const d = res.data;

    const usersEl  = document.getElementById('usersCount');
    const txEl     = document.getElementById('transactionsCount');
    const totalEl  = document.getElementById('balanceTotal');

    if (usersEl)  usersEl.textContent  = `Utilisateurs: ${d.totalUsers || 0}`;
    if (txEl)     txEl.textContent     = `Transactions: ${d.totalTransactions || 0}`;
    if (totalEl)  totalEl.textContent  = `Total: ${formatMoney(d.totalBalance || 0)}`;

    // Graphique
    drawStatsChart(d);
  }

  function drawStatsChart(stats) {
    const canvas = document.getElementById('adminChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const roleData = stats.roleBreakdown || {};
    const labels   = Object.keys(roleData);
    const values   = labels.map((k) => roleData[k]);

    new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: ['#3b82f6', '#f59e0b', '#ef4444'],
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } },
      },
    });
  }

  // ----------------------------------------------------------
  // Onglets
  // ----------------------------------------------------------
  function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');

        // Masquer tous les contenus
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));

        currentTab = tab.dataset.tab;
        const content = document.getElementById('tab-' + currentTab);
        if (content) content.classList.remove('hidden');

        // Charger le contenu de l'onglet
        loadTabContent(currentTab);
      });
    });
  }

  async function loadTabContent(tab) {
    switch (tab) {
      case 'users':        await loadUsers();        break;
      case 'transactions': await loadTransactions(); break;
      case 'logs':         await loadLogs();         break;
      case 'banks':        await loadBanks();        break;
    }
  }

  // ----------------------------------------------------------
  // Onglet Utilisateurs
  // ----------------------------------------------------------
  async function loadUsers(q) {
    const res = await window.API.admin.getUsers({ q: q || undefined, limit: 50 });
    if (res.error) return;

    const tbody = document.getElementById('usersTable');
    if (!tbody) return;

    tbody.innerHTML = '';

    const users = res.data.users || [];

    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-muted);">Aucun utilisateur</td></tr>';
      return;
    }

    users.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <strong>${escHtml(u.displayName)}</strong><br>
          <small style="color:var(--color-text-muted);">@${escHtml(u.username)}</small>
        </td>
        <td>${escHtml(u.email)}</td>
        <td>
          <select data-user-id="${u.id}" class="role-select" style="padding:4px 8px; border-radius:6px; border:1px solid var(--color-border);">
            <option value="user"     ${u.role === 'user'     ? 'selected' : ''}>user</option>
            <option value="employee" ${u.role === 'employee' ? 'selected' : ''}>employee</option>
            <option value="admin"    ${u.role === 'admin'    ? 'selected' : ''}>admin</option>
          </select>
        </td>
        <td>
          <label style="display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="checkbox" data-user-id="${u.id}" class="tpe-check" ${u.hasTpe ? 'checked' : ''}>
            TPE
          </label>
        </td>
        <td style="display:flex; gap:6px; flex-wrap:wrap;">
          <button
            data-user-id="${u.id}"
            data-is-active="${u.isActive}"
            class="status-btn"
            style="padding:4px 8px; border:none; border-radius:6px; cursor:pointer;
                   background:${u.isActive ? 'var(--color-warning)' : 'var(--color-success)'}; color:white; font-size:0.8rem;"
          >
            ${u.isActive ? 'Désactiver' : 'Activer'}
          </button>
          <button
            data-user-id="${u.id}"
            data-is-frozen="${u.account?.isFrozen}"
            class="freeze-btn"
            style="padding:4px 8px; border:none; border-radius:6px; cursor:pointer;
                   background:${u.account?.isFrozen ? 'var(--color-success)' : 'var(--color-info)'}; color:white; font-size:0.8rem;"
          >
            ${u.account?.isFrozen ? 'Dégeler' : 'Geler'}
          </button>
          <button
            data-user-id="${u.id}"
            data-username="${escHtml(u.username)}"
            class="delete-btn"
            style="padding:4px 8px; border:none; border-radius:6px; cursor:pointer;
                   background:var(--color-error); color:white; font-size:0.8rem;"
          >
            Supprimer
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Attacher les événements
    tbody.querySelectorAll('.role-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const userId = parseInt(sel.dataset.userId, 10);
        const role   = sel.value;
        const res    = await window.API.admin.setRole(userId, role);
        if (res.error) { alert(res.error); loadUsers(); }
        else            alert('Rôle mis à jour.');
      });
    });

    tbody.querySelectorAll('.tpe-check').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const userId = parseInt(cb.dataset.userId, 10);
        const res    = await window.API.admin.setTpe(userId, cb.checked, '');
        if (res.error) { alert(res.error); loadUsers(); }
      });
    });

    tbody.querySelectorAll('.status-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const userId   = parseInt(btn.dataset.userId, 10);
        const isActive = btn.dataset.isActive === 'true';
        const res      = await window.API.admin.setStatus(userId, !isActive);
        if (res.error) alert(res.error);
        else           loadUsers();
      });
    });

    tbody.querySelectorAll('.freeze-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const userId   = parseInt(btn.dataset.userId, 10);
        const isFrozen = btn.dataset.isFrozen === 'true';
        const res      = await window.API.admin.freezeAccount(userId, !isFrozen);
        if (res.error) alert(res.error);
        else           loadUsers();
      });
    });

    tbody.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const userId   = parseInt(btn.dataset.userId, 10);
        const username = btn.dataset.username;
        if (!confirm(`Supprimer définitivement l'utilisateur @${username} ?`)) return;
        const res = await window.API.admin.deleteUser(userId);
        if (res.error) alert(res.error);
        else           loadUsers();
      });
    });
  }

  // ----------------------------------------------------------
  // Onglet Transactions
  // ----------------------------------------------------------
  async function loadTransactions() {
    const container = document.getElementById('transactionsAdmin');
    if (!container) return;

    const res = await window.API.admin.getTransactions({ limit: 30 });
    if (res.error || !res.data) {
      container.innerHTML = '<p style="color:var(--color-error);">Erreur de chargement.</p>';
      return;
    }

    const txs = res.data.transactions || [];

    if (txs.length === 0) {
      container.innerHTML = '<p style="color:var(--color-text-muted); text-align:center;">Aucune transaction</p>';
      return;
    }

    container.innerHTML = `
      <table class="table" style="width:100%; border-collapse:collapse;">
        <thead>
          <tr>
            <th>Type</th><th>De</th><th>Vers</th><th>Montant</th><th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${txs.map((tx) => `
            <tr>
              <td>${escHtml(tx.type)}</td>
              <td>${tx.from ? escHtml(tx.from.username) : '-'}</td>
              <td>${tx.to   ? escHtml(tx.to.username)   : '-'}</td>
              <td>${formatMoney(tx.amount)}</td>
              <td>${formatDate(tx.createdAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ----------------------------------------------------------
  // Onglet Journaux
  // ----------------------------------------------------------
  async function loadLogs() {
    const container = document.getElementById('logsTable');
    if (!container) return;

    const res = await window.API.admin.getLogs({ limit: 50 });
    if (res.error || !res.data) {
      container.innerHTML = '<p style="color:var(--color-error);">Erreur de chargement.</p>';
      return;
    }

    const logs = res.data.logs || [];

    if (logs.length === 0) {
      container.innerHTML = '<p style="color:var(--color-text-muted); text-align:center;">Aucun journal</p>';
      return;
    }

    container.innerHTML = `
      <table class="table" style="width:100%; border-collapse:collapse;">
        <thead>
          <tr><th>Action</th><th>Acteur</th><th>Cible</th><th>Date</th></tr>
        </thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td><code style="font-size:0.8rem;">${escHtml(l.action)}</code></td>
              <td>${l.actor ? escHtml(l.actor.username) : '-'}</td>
              <td>${l.target ? escHtml(l.target.username) : '-'}</td>
              <td style="font-size:0.8rem;">${formatDate(l.createdAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ----------------------------------------------------------
  // Onglet Banques
  // ----------------------------------------------------------
  async function loadBanks() {
    const container = document.getElementById('banksList');
    if (!container) return;

    const res = await window.API.admin.getBanks();
    if (res.error || !res.data) {
      container.innerHTML = '<p style="color:var(--color-error);">Erreur de chargement.</p>';
      return;
    }

    const banks = res.data.banks || [];

    container.innerHTML = banks.map((b) => `
      <div style="
        padding: 10px 16px; background: var(--color-bg-subtle);
        border: 1px solid var(--color-border); border-radius: 8px; margin-bottom: 8px;
        display:flex; justify-content:space-between;
      ">
        <strong>${escHtml(b.name)}</strong>
        <code>${escHtml(b.code)}</code>
      </div>
    `).join('') || '<p style="color:var(--color-text-muted);">Aucune banque</p>';
  }

  // Exposée globalement pour le bouton dans admin.html
  window.createBank = async function () {
    const nameEl = document.getElementById('bankName');
    const codeEl = document.getElementById('bankCode');

    const name = (nameEl || {}).value?.trim();
    const code = (codeEl || {}).value?.trim();

    if (!name || !code) {
      alert('Nom et code requis.');
      return;
    }

    const res = await window.API.admin.createBank({ name, code });
    if (res.error) {
      alert(res.error);
    } else {
      if (nameEl) nameEl.value = '';
      if (codeEl) codeEl.value = '';
      await loadBanks();
    }
  };

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    const user = await checkAdmin();
    if (!user) return;

    await loadStats();
    initTabs();
    await loadUsers(); // Onglet par défaut
  });
})();
