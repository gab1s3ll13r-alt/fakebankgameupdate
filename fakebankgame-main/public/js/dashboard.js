// ============================================================
// public/js/dashboard.js
// Logique commune des pages connectees (sidebar, topbar,
// notifications, polling solde) + logique specifique dashboard.
// Charge sur toutes les pages qui ont une sidebar.
// ============================================================
(function () {
  'use strict';

  // ----------------------------------------------------------
  // Utilitaires globaux (disponibles pour les autres scripts)
  // ----------------------------------------------------------

  window.formatAmount = function (cents, currency) {
    const cur = currency || 'EUR';
    const num = (cents / 100).toLocaleString('fr-FR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${num} ${cur === 'EUR' ? '€' : cur}`;
  };

  window.formatDate = function (iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000)   return 'à l\'instant';
    if (diff < 3600000) return `il y a ${Math.floor(diff/60000)} min`;
    if (diff < 86400000) return `il y a ${Math.floor(diff/3600000)} h`;
    return d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
  };

  window.showToast = function (title, message, type) {
    type = type || 'info';
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <div class="toast-body">
        <div class="toast-title">${title}</div>
        ${message ? `<div class="toast-message">${message}</div>` : ''}
      </div>
      <button onclick="this.closest('.toast').remove()" style="background:none;border:none;cursor:pointer;font-size:1.2em;line-height:1;">✕</button>
    `;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  };

  // Avatar initiales
  window.getInitials = function (name) {
    if (!name) return 'U';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  // Icone direction transaction
  window.txIcon = function (direction, type) {
    if (direction === 'incoming') return '↓';
    if (direction === 'outgoing') return '↑';
    if (type === 'manual_credit') return '+';
    if (type === 'manual_debit')  return '-';
    return '↔';
  };

  // ----------------------------------------------------------
  // Verification session (redirect si non connecte)
  // ----------------------------------------------------------
  let currentUser = null;

  window.getCurrentUser = function () { return currentUser; };

  async function checkSession() {
    const { data, error } = await API.auth.me();
    if (error || !data || !data.user) {
      window.location.href = '/login.html';
      return null;
    }
    currentUser = data.user;
    return data.user;
  }

  // ----------------------------------------------------------
  // Sidebar dynamique (liens conditionnels selon role/tpe)
  // ----------------------------------------------------------
  function initSidebar(user) {
    const tpeLink      = document.getElementById('tpeLink');
    const employeeLink = document.getElementById('employeeLink');
    const adminLink    = document.getElementById('adminLink');

    if (tpeLink)      tpeLink.style.display      = (user.hasTpe || user.role === 'admin') ? '' : 'none';
    if (employeeLink) employeeLink.style.display  = (user.role === 'employee' || user.role === 'admin') ? '' : 'none';
    if (adminLink)    adminLink.style.display     = user.role === 'admin' ? '' : 'none';

    // Avatar sidebar si present
    const sidebarAvatar = document.getElementById('sidebarAvatar');
    if (sidebarAvatar) sidebarAvatar.textContent = getInitials(user.displayName);

    const sidebarName = document.getElementById('sidebarName');
    if (sidebarName) sidebarName.textContent = user.displayName;
  }

  // ----------------------------------------------------------
  // Notifications
  // ----------------------------------------------------------
  let unreadCount = 0;

  async function loadNotifications() {
    const { data } = await API.account.getNotifications({ limit: 20 });
    if (!data) return;

    unreadCount = data.unreadCount || 0;

    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.textContent = unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : '';
      badge.style.display = unreadCount > 0 ? 'flex' : 'none';
    }

    const list = document.getElementById('notifList');
    if (!list) return;

    if (!data.notifications.length) {
      list.innerHTML = '<div class="empty-state"><p>Aucune notification</p></div>';
      return;
    }

    list.innerHTML = data.notifications.map(n => `
      <div class="notification-item ${n.isRead ? '' : 'unread'}" data-id="${n.id}" onclick="markNotifRead(${n.id}, this)">
        <div class="notification-item-icon type-${n.type}">
          ${n.type === 'success' ? '✓' : n.type === 'warning' ? '!' : 'i'}
        </div>
        <div class="notification-item-content">
          <div class="notification-item-title">${n.title}</div>
          <div class="notification-item-message">${n.message}</div>
          <div class="notification-item-date">${formatDate(n.createdAt)}</div>
        </div>
      </div>
    `).join('');
  }

  window.markNotifRead = async function (id, el) {
    await API.account.markRead(id);
    if (el) el.classList.remove('unread');
    if (unreadCount > 0) {
      unreadCount--;
      const badge = document.getElementById('notifBadge');
      if (badge) {
        badge.textContent = unreadCount > 0 ? unreadCount : '';
        badge.style.display = unreadCount > 0 ? 'flex' : 'none';
      }
    }
  };

  window.markAllNotifRead = async function () {
    await API.account.markAllRead();
    unreadCount = 0;
    const badge = document.getElementById('notifBadge');
    if (badge) { badge.textContent = ''; badge.style.display = 'none'; }
    document.querySelectorAll('.notification-item.unread').forEach(el => el.classList.remove('unread'));
  };

  // Toggle panel notifications
  window.toggleNotifPanel = function () {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) loadNotifications();
  };

  // Ferme panel si clic dehors
  document.addEventListener('click', (e) => {
    const panel   = document.getElementById('notifPanel');
    const trigger = document.getElementById('notifTrigger');
    if (panel && panel.style.display !== 'none') {
      if (!panel.contains(e.target) && trigger && !trigger.contains(e.target)) {
        panel.style.display = 'none';
      }
    }
  });

  // ----------------------------------------------------------
  // Polling solde (toutes les 30 secondes)
  // ----------------------------------------------------------
  let pollingInterval = null;

  function startPolling() {
    pollingInterval = setInterval(async () => {
      const { data } = await API.account.getBalance();
      if (!data) return;
      const el = document.getElementById('balanceAmount');
      if (el) el.textContent = formatAmount(data.balance, data.currency);

      const { data: notifData } = await API.account.getNotifications({ unread: 'true', limit: 1 });
      if (notifData && notifData.unreadCount !== unreadCount) {
        unreadCount = notifData.unreadCount;
        const badge = document.getElementById('notifBadge');
        if (badge) {
          badge.textContent = unreadCount > 0 ? unreadCount : '';
          badge.style.display = unreadCount > 0 ? 'flex' : 'none';
        }
        if (unreadCount > 0) {
          showToast('Nouvelle notification', '', 'info');
        }
      }
    }, 30000);
  }

  window.addEventListener('beforeunload', () => {
    if (pollingInterval) clearInterval(pollingInterval);
  });

  // ----------------------------------------------------------
  // DASHBOARD specifique
  // ----------------------------------------------------------
  async function initDashboard() {
    if (!document.getElementById('balanceAmount')) return;

    // Compte
    const { data: accountData } = await API.account.get();
    if (accountData && accountData.account) {
      const acc = accountData.account;
      const el  = document.getElementById('balanceAmount');
      if (el) el.textContent = formatAmount(acc.balance, acc.currency);

      const ibanEl = document.getElementById('iban');
      if (ibanEl) {
        ibanEl.textContent = acc.ibanFormatted || acc.iban;
        ibanEl.title = 'Cliquer pour copier';
        ibanEl.style.cursor = 'pointer';
        ibanEl.onclick = () => {
          navigator.clipboard.writeText(acc.iban).then(() => showToast('IBAN copié', '', 'success'));
        };
      }
    }

    // Transactions recentes
    const { data: histData } = await API.transactions.getHistory({ limit: 5 });
    const lastTxEl = document.getElementById('lastTransactions');
    if (lastTxEl && histData && histData.transactions) {
      if (!histData.transactions.length) {
        lastTxEl.innerHTML = '<div class="empty-state"><p>Aucune transaction</p></div>';
      } else {
        lastTxEl.innerHTML = histData.transactions.map(tx => `
          <div class="transaction-item">
            <div class="transaction-icon direction-${tx.direction}">
              ${txIcon(tx.direction, tx.type)}
            </div>
            <div class="transaction-info">
              <div class="transaction-name">
                ${tx.direction === 'incoming' ? (tx.from?.displayName || 'Système') : (tx.to?.displayName || 'Système')}
              </div>
              <div class="transaction-desc">${tx.description || tx.type}</div>
            </div>
            <div class="transaction-right">
              <div class="transaction-amount ${tx.direction === 'incoming' ? 'positive' : tx.direction === 'outgoing' ? 'negative' : ''}">
                ${tx.direction === 'incoming' ? '+' : tx.direction === 'outgoing' ? '-' : ''}${formatAmount(tx.amount)}
              </div>
              <div class="transaction-date">${formatDate(tx.createdAt)}</div>
            </div>
          </div>
        `).join('');
      }
    }

    // Resume / stats
    const { data: summaryData } = await API.transactions.getSummary(30);
    if (summaryData) {
      const totalIn  = summaryData.days.reduce((s, d) => s + d.totalIn,  0);
      const totalOut = summaryData.days.reduce((s, d) => s + d.totalOut, 0);
      const txCount  = summaryData.days.reduce((s, d) => s + (d.totalIn > 0 || d.totalOut > 0 ? 1 : 0), 0);

      const recvEl  = document.getElementById('received');
      const sentEl  = document.getElementById('sent');
      const countEl = document.getElementById('txCount');
      if (recvEl)  recvEl.textContent  = formatAmount(totalIn);
      if (sentEl)  sentEl.textContent  = formatAmount(totalOut);
      if (countEl) countEl.textContent = txCount;

      // Graphique Chart.js
      const canvas = document.getElementById('chart');
      if (canvas && typeof Chart !== 'undefined') {
        const labels = summaryData.days.map(d => d.date);
        const inData = summaryData.days.map(d => +(d.totalIn  / 100).toFixed(2));
        const outData= summaryData.days.map(d => +(d.totalOut / 100).toFixed(2));

        new Chart(canvas, {
          type: 'line',
          data: {
            labels,
            datasets: [
              { label: 'Reçus',   data: inData,  borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,.1)',  tension: 0.4, fill: true },
              { label: 'Envoyés', data: outData, borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,.1)',  tension: 0.4, fill: true },
            ],
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: true } },
            scales: { y: { beginAtZero: true } },
          },
        });
      }
    }

    // Polling
    startPolling();
  }

  // ----------------------------------------------------------
  // Init globale
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    const user = await checkSession();
    if (!user) return;

    initSidebar(user);
    loadNotifications();
    initDashboard();
  });
})();