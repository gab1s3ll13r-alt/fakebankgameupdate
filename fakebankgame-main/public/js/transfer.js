
// ============================================================
// public/js/transfer.js
// Logique de la page de virement (transfer.html).
// ============================================================
(function () {
  'use strict';

  let selectedRecipient = null;
  let currentBalanceCents = 0;
  let searchDebounce = null;

  // ----------------------------------------------------------
  // Recherche destinataire
  // ----------------------------------------------------------
  function initRecipientSearch() {
    const input   = document.getElementById('recipientSearch');
    const results = document.getElementById('searchResults');
    if (!input || !results) return;

    // Pre-remplissage si ?to=userId dans l'URL
    const params = new URLSearchParams(window.location.search);
    const toId   = params.get('to');
    if (toId) {
      API.employee.getAccount(toId).then(({ data }) => {
        if (data && data.user) selectRecipient(data.user, data.account);
      });
    }

    input.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; results.style.display = 'none'; return; }

      searchDebounce = setTimeout(async () => {
        const { data, error } = await API.users.search(q);
        if (error || !data) return;

        if (!data.results.length) {
          results.innerHTML = '<div class="recipient-option text-muted" style="padding:12px">Aucun résultat</div>';
          results.style.display = 'block';
          return;
        }

        results.innerHTML = data.results.map(u => `
          <div class="recipient-option" onclick="window._selectRecipient(${JSON.stringify(u).replace(/"/g,'&quot;')})">
            <div class="avatar avatar-sm">${getInitials(u.displayName)}</div>
            <div class="recipient-option-info">
              <div class="recipient-option-name">${u.displayName}</div>
              <div class="recipient-option-iban">@${u.username} · ${u.ibanMasked}</div>
            </div>
          </div>
        `).join('');
        results.style.display = 'block';
      }, 300);
    });

    // Ferme dropdown si clic dehors
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !results.contains(e.target)) {
        results.style.display = 'none';
      }
    });
  }

  function selectRecipient(user, account) {
    selectedRecipient = user;
    const card = document.getElementById('recipientCard');
    const info = document.getElementById('recipientInfo');
    const search= document.getElementById('recipientSearch');
    const results=document.getElementById('searchResults');

    if (info) info.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px">
        <div class="avatar avatar-sm">${getInitials(user.displayName)}</div>
        <div>
          <strong>${user.displayName}</strong>
          <div class="text-muted" style="font-size:.8em">@${user.username} · ${user.ibanMasked || (account && account.ibanFormatted) || ''}</div>
        </div>
      </div>
    `;

    if (card)    card.style.display  = 'block';
    if (search)  search.value = '';
    if (results) results.style.display = 'none';
    updatePreview();
  }

  // Expose pour onclick inline
  window._selectRecipient = selectRecipient;

  window.clearRecipient = function () {
    selectedRecipient = null;
    const card = document.getElementById('recipientCard');
    if (card) card.style.display = 'none';
    updatePreview();
  };

  // ----------------------------------------------------------
  // Apercu
  // ----------------------------------------------------------
  function updatePreview() {
    const previewEl = document.getElementById('preview');
    if (!previewEl) return;

    const amount = parseFloat(document.getElementById('amount')?.value || 0);
    const amountCents = Math.round(amount * 100);
    const afterCents  = currentBalanceCents - amountCents;

    if (!selectedRecipient || !amount || amount <= 0) {
      previewEl.innerHTML = '';
      return;
    }

    previewEl.innerHTML = `
      <div class="transfer-preview">
        <div class="transfer-preview-row">
          <span class="transfer-preview-label">Destinataire</span>
          <span class="transfer-preview-value">${selectedRecipient.displayName}</span>
        </div>
        <div class="transfer-preview-row">
          <span class="transfer-preview-label">Montant</span>
          <span class="transfer-preview-value">${formatAmount(amountCents)}</span>
        </div>
        <div class="transfer-preview-row">
          <span class="transfer-preview-label">Solde après</span>
          <span class="transfer-preview-value ${afterCents < 0 ? 'insufficient' : ''}">${formatAmount(afterCents)}</span>
        </div>
      </div>
    `;
  }

  // ----------------------------------------------------------
  // Confirmation et envoi
  // ----------------------------------------------------------
  async function confirmTransfer() {
    if (!selectedRecipient) {
      showToast('Destinataire manquant', 'Veuillez sélectionner un destinataire.', 'error');
      return;
    }

    const amount = parseFloat(document.getElementById('amount')?.value || 0);
    if (!amount || amount <= 0) {
      showToast('Montant invalide', 'Veuillez saisir un montant valide.', 'error');
      return;
    }

    const amountCents = Math.round(amount * 100);
    if (amountCents > currentBalanceCents) {
      showToast('Solde insuffisant', 'Votre solde est insuffisant pour ce virement.', 'error');
      return;
    }

    const description = document.getElementById('description')?.value?.trim() || '';

    // Modal de confirmation
    if (!confirm(`Envoyer ${formatAmount(amountCents)} à ${selectedRecipient.displayName} ?`)) return;

    const btn = document.getElementById('confirmTransferBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }

    const { data, error } = await API.transactions.transfer({
      recipientId: selectedRecipient.id,
      amount:      amount,
      description: description || undefined,
    });

    if (btn) { btn.disabled = false; btn.textContent = 'Confirmer le virement'; }

    if (error) {
      showToast('Erreur', error, 'error');
      return;
    }

    showToast('Virement effectué', `${formatAmount(amountCents)} envoyé à ${selectedRecipient.displayName}.`, 'success');
    currentBalanceCents = data.newBalance;
    const balEl = document.getElementById('currentBalance');
    if (balEl) balEl.textContent = formatAmount(currentBalanceCents);

    // Reset formulaire
    selectedRecipient = null;
    document.getElementById('recipientCard') && (document.getElementById('recipientCard').style.display = 'none');
    document.getElementById('amount')        && (document.getElementById('amount').value = '');
    document.getElementById('description')   && (document.getElementById('description').value = '');
    document.getElementById('preview')       && (document.getElementById('preview').innerHTML = '');

    setTimeout(() => window.location.href = '/history.html', 1500);
  }

  // ----------------------------------------------------------
  // Init
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async () => {
    // Solde courant
    const { data } = await API.account.getBalance();
    if (data) {
      currentBalanceCents = data.balance;
      const el = document.getElementById('currentBalance');
      if (el) el.textContent = formatAmount(data.balance, data.currency);
    }

    initRecipientSearch();

    const amountInput = document.getElementById('amount');
    if (amountInput) amountInput.addEventListener('input', updatePreview);

    const confirmBtn = document.getElementById('confirmTransferBtn');
    if (confirmBtn) confirmBtn.addEventListener('click', confirmTransfer);
  });
})();