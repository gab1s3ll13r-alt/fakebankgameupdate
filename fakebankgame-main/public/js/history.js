// ============================================================
// public/js/history.js
// Historique des transactions
// ============================================================

(function () {
  'use strict';

  let currentPage = 1;
  let currentType = null; // null = tous
  let totalPages  = 1;

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
    return new Date(dateStr).toLocaleString('fr-FR', {
      day:    '2-digit',
      month:  '2-digit',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
    });
  }

  function typeLabel(type) {
    const labels = {
      transfer:      'Virement',
      tpe_payment:   'TPE',
      manual_credit: 'Crédit',
      manual_debit:  'Débit',
      admin_adjust:  'Ajustement',
    };
    return labels[type] || type;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ----------------------------------------------------------
  // Charger l'historique
  // ----------------------------------------------------------
  async function loadHistory() {
    const tbody = document.getElementById('transactionsBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--color-text-muted);">Chargement...</td></tr>';

    const res = await window.API.transactions.getHistory({
      page:  currentPage,
      limit: 20,
      type:  currentType || undefined,
    });

    if (res.error || !res.data) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--color-error);">Erreur de chargement.</td></tr>';
      return;
    }

    const { transactions, pagination } = res.data;
    totalPages = pagination?.totalPages || 1;

    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo) {
      pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    }

    updatePaginationButtons();

    if (!transactions || transactions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--color-text-muted);">Aucune transaction</td></tr>';
      return;
    }

    tbody.innerHTML = '';

    transactions.forEach((tx) => {
      const isIn  = tx.direction === 'incoming';
      const color = isIn ? 'var(--color-success)' : 'var(--color-error)';
      const sign  = isIn ? '+' : '-';

      const other = isIn ? tx.from : tx.to;
      const desc  = tx.description || (other ? other.displayName : typeLabel(tx.type));

      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = `
        <td>${escHtml(typeLabel(tx.type))}</td>
        <td>${escHtml(desc || '')}</td>
        <td>${escHtml(formatDate(tx.createdAt))}</td>
        <td style="font-weight:700; color:${color};">${sign}${formatMoney(tx.amount)}</td>
      `;

      tr.addEventListener('click', () => showDetails(tx));
      tbody.appendChild(tr);
    });
  }

  // ----------------------------------------------------------
  // Détails transaction (modal simple)
  // ----------------------------------------------------------
  function showDetails(tx) {
    const isIn  = tx.direction === 'incoming';
    const other = isIn ? tx.from : tx.to;

    let msg = `Type : ${typeLabel(tx.type)}\n`;
    msg += `Montant : ${formatMoney(tx.amount)}\n`;
    msg += `Date : ${formatDate(tx.createdAt)}\n`;
    msg += `Statut : ${tx.status}\n`;
    if (tx.description) msg += `Description : ${tx.description}\n`;
    if (other) msg += `${isIn ? 'De' : 'Vers'} : ${other.displayName} (@${other.username})\n`;
    if (tx.balanceAfter !== null && tx.balanceAfter !== undefined) {
      msg += `Solde après : ${formatMoney(tx.balanceAfter)}\n`;
    }
    if (tx.performedBy) msg += `Opéré par : ${tx.performedBy}\n`;

    alert(msg);
  }

  // ----------------------------------------------------------
  // Pagination
  // ----------------------------------------------------------
  function updatePaginationButtons() {
    const prev = document.getElementById('prevPage');
    const next = document.getElementById('nextPage');

    if (prev) prev.disabled = currentPage <= 1;
    if (next) next.disabled = currentPage >= totalPages;
  }

  function initPagination() {
    const prev = document.getElementById('prevPage');
    const next = document.getElementById('nextPage');

    if (prev) {
      prev.addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; loadHistory(); }
      });
    }

    if (next) {
      next.addEventListener('click', () => {
        if (currentPage < totalPages) { currentPage++; loadHistory(); }
      });
    }
  }

  // ----------------------------------------------------------
  // Filtres
  // ----------------------------------------------------------
  function initFilters() {
    // history.html utilise des <button data-type="...">
    const filterBtns = document.querySelectorAll('[data-type]');

    filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        filterBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        const type = btn.dataset.type;
        currentType = (type === 'all' || type === 'manual') ? null : type;

        // Le type "manual" = credit + debit manuels : non filtrable en une query simple
        // On laisse null pour afficher tout
        currentPage = 1;
        loadHistory();
      });
    });
  }

  // ----------------------------------------------------------
  // Adaptation sidebar selon rôle
  // ----------------------------------------------------------
  async function adaptSidebar() {
    const res = await window.API.auth.me();
    if (res.error || !res.data) {
      window.location.href = '/login.html';
      return;
    }

    const user         = res.data.user;
    const tpeLink      = document.getElementById('tpeLink');
    const employeeLink = document.getElementById('employeeLink');
    const adminLink    = document.getElementById('adminLink');

    if (tpeLink)      tpeLink.style.display      = user.hasTpe || user.role === 'admin' ? '' : 'none';
    if (employeeLink) employeeLink.style.display  = (user.role === 'employee' || user.role === 'admin') ? '' : 'none';
    if (adminLink)    adminLink.style.display     = user.role === 'admin' ? '' : 'none';
  }

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    await adaptSidebar();
    initPagination();
    initFilters();
    loadHistory();
  });
})();
