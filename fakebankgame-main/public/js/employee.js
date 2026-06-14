// ============================================================
// public/js/employee.js
// Interface employé banque
// - Gestion comptes utilisateurs
// - Crédit / débit
// - Consultation des comptes et transactions
// ============================================================

(function () {
  'use strict';

  // ----------------------------------------------------------
  // DOM
  // ----------------------------------------------------------
  const dom = {
    searchInput: document.getElementById('searchUser'),
    results: document.getElementById('results'),

    selectedUser: document.getElementById('selectedUser'),

    creditForm: document.getElementById('creditForm'),
    debitForm: document.getElementById('debitForm'),

    transactions: document.getElementById('transactions'),
  };

  let currentUser = null;
  let searchTimeout = null;

  // ----------------------------------------------------------
  // Recherche utilisateurs
  // ----------------------------------------------------------
  function initSearch() {
    if (!dom.searchInput || !dom.results) return;

    dom.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);

      const q = dom.searchInput.value.trim();

      if (q.length < 2) {
        dom.results.innerHTML = '';
        return;
      }

      searchTimeout = setTimeout(async () => {
        const res = await window.API.users.search(q);
        if (res.error) return;

        dom.results.innerHTML = '';

        (res.data.users || []).forEach((user) => {
          const div = document.createElement('div');
          div.className = 'user-item';

          div.innerHTML = `
            <strong>${user.username}</strong>
            <small>${user.ibanMasked || ''}</small>
          `;

          div.addEventListener('click', () => {
            currentUser = user;

            if (dom.selectedUser) {
              dom.selectedUser.textContent = user.username;
            }

            dom.results.innerHTML = '';
            dom.searchInput.value = '';

            loadTransactions();
          });

          dom.results.appendChild(div);
        });
      }, 300);
    });
  }

  // ----------------------------------------------------------
  // Transactions utilisateur
  // ----------------------------------------------------------
  async function loadTransactions() {
    if (!currentUser) return;

    const res = await window.API.employee.getTransactions(currentUser.id, {
      limit: 10,
    });

    if (res.error || !dom.transactions) return;

    dom.transactions.innerHTML = '';

    (res.data.transactions || []).forEach((t) => {
      const div = document.createElement('div');
      div.className = 'transaction-item';

      div.innerHTML = `
        <div>
          <strong>${t.description || 'Transaction'}</strong>
          <small>${new Date(t.created_at).toLocaleString('fr-FR')}</small>
        </div>
        <div>
          ${t.amount} €
        </div>
      `;

      dom.transactions.appendChild(div);
    });
  }

  // ----------------------------------------------------------
  // Crédit compte
  // ----------------------------------------------------------
  function initCredit() {
    if (!dom.creditForm) return;

    dom.creditForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!currentUser) return alert('Sélectionne un utilisateur');

      const amount = Number(dom.creditForm.amount.value);
      const description = dom.creditForm.description.value;

      if (!amount || amount <= 0) return alert('Montant invalide');

      const res = await window.API.employee.credit(currentUser.id, {
        amount: Math.round(amount * 100),
        description,
      });

      if (res.error) return alert(res.error);

      alert('Crédit effectué');
      loadTransactions();
    });
  }

  // ----------------------------------------------------------
  // Débit compte
  // ----------------------------------------------------------
  function initDebit() {
    if (!dom.debitForm) return;

    dom.debitForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!currentUser) return alert('Sélectionne un utilisateur');

      const amount = Number(dom.debitForm.amount.value);
      const description = dom.debitForm.description.value;

      if (!amount || amount <= 0) return alert('Montant invalide');

      const res = await window.API.employee.debit(currentUser.id, {
        amount: Math.round(amount * 100),
        description,
      });

      if (res.error) return alert(res.error);

      alert('Débit effectué');
      loadTransactions();
    });
  }

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initSearch();
    initCredit();
    initDebit();
  });
})();
