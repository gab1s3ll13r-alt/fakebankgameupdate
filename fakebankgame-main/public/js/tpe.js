// ============================================================
// public/js/tpe.js
// Interface TPE commerçant (tpe.html) + page paiement (tpe-pay.html)
// ============================================================

(function () {
  'use strict';

  var currentQrUuid = null;
  var pollingInterval = null;

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------
  function formatMoney(cents) {
    return (cents / 100).toLocaleString('fr-FR', {
      style:    'currency',
      currency: 'EUR',
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ----------------------------------------------------------
  // PAGE TPE COMMERÇANT (tpe.html)
  // ----------------------------------------------------------
  async function initTpePage() {
    // Vérifier la connexion et l'accès TPE
    const res = await window.API.auth.me();
    if (res.error || !res.data) {
      window.location.href = '/login.html';
      return;
    }

    const user = res.data.user;

    // Vérifier accès TPE (has_tpe = true OU rôle admin)
    if (!user.hasTpe && user.role !== 'admin') {
      window.location.href = '/dashboard.html';
      return;
    }

    // Afficher le libellé du commerce
    const tpeLabelEl = document.getElementById('tpeLabel');
    if (tpeLabelEl) {
      tpeLabelEl.textContent = user.tpeLabel || 'Mon commerce';
    }

    await loadBalance();
    await loadTpeHistory();
    setupTpeEvents();
  }

  // ----------------------------------------------------------
  // Charger le solde
  // ----------------------------------------------------------
  async function loadBalance() {
    const res = await window.API.account.getBalance();
    if (res.error || !res.data) return;

    const el = document.getElementById('tpeBalance');
    if (el) el.textContent = formatMoney(res.data.balance || 0);
  }

  // ----------------------------------------------------------
  // Événements du TPE
  // ----------------------------------------------------------
  function setupTpeEvents() {
    var generateBtn = document.getElementById('generateQrBtn');
    var cancelBtn   = document.getElementById('cancelQrBtn');

    if (generateBtn) generateBtn.addEventListener('click', generateQr);
    if (cancelBtn)   cancelBtn.addEventListener('click',   cancelQr);
  }

  // ----------------------------------------------------------
  // Générer un QR code de paiement
  // ----------------------------------------------------------
  async function generateQr() {
    var amountInput = document.getElementById('amountInput');
    var labelInput  = document.getElementById('labelInput');

    var amount = parseFloat((amountInput || {}).value || '0');
    var label  = ((labelInput || {}).value || '').trim();

    if (!amount || amount <= 0) {
      alert('Veuillez entrer un montant valide.');
      return;
    }

    var generateBtn = document.getElementById('generateQrBtn');
    if (generateBtn) { generateBtn.disabled = true; generateBtn.textContent = 'Création...'; }

    var res = await window.API.tpe.request({ amount: amount, label: label || undefined });

    if (generateBtn) { generateBtn.disabled = false; generateBtn.textContent = 'Générer QR Code'; }

    if (res.error || !res.data) {
      alert(res.error || 'Erreur lors de la création du QR code.');
      return;
    }

    var payment    = res.data.payment;
    currentQrUuid  = payment.qrCodeUuid;

    // Construire l'URL de paiement
    var payUrl = window.location.origin + '/tpe-pay.html?qr=' + encodeURIComponent(currentQrUuid);

    // Afficher la carte QR
    var qrCard = document.getElementById('qrCard');
    if (qrCard) qrCard.style.display = '';

    // Générer le QR code avec la lib QRCode.js (disponible via CDN dans tpe.html)
    var container = document.getElementById('qrCodeContainer');
    if (container) {
      container.innerHTML = '';

      if (typeof QRCode !== 'undefined') {
        var canvas = document.createElement('canvas');
        QRCode.toCanvas(canvas, payUrl, { width: 200, margin: 2 }, function (err) {
          if (!err) container.appendChild(canvas);
        });
      } else {
        // Fallback texte si la lib n'est pas chargée
        container.innerHTML = '<p style="word-break:break-all; font-size:0.8rem;">' + escHtml(payUrl) + '</p>';
      }
    }

    // Mettre à jour le statut
    var statusEl = document.getElementById('paymentStatus');
    if (statusEl) {
      statusEl.innerHTML = `
        <p style="color:var(--color-text-muted);">
          En attente de paiement — <strong>${formatMoney(payment.amount)}</strong>
        </p>
        <p style="font-size:0.8rem; color:var(--color-text-muted);">
          URL : <a href="${escHtml(payUrl)}" target="_blank">${escHtml(payUrl)}</a>
        </p>
      `;
    }

    // Démarrer le polling
    startPolling(currentQrUuid);
  }

  // ----------------------------------------------------------
  // Annuler un QR code en attente
  // ----------------------------------------------------------
  async function cancelQr() {
    if (!currentQrUuid) return;

    stopPolling();

    await window.API.tpe.cancel(currentQrUuid);

    currentQrUuid = null;

    var qrCard = document.getElementById('qrCard');
    if (qrCard) qrCard.style.display = 'none';

    var statusEl = document.getElementById('paymentStatus');
    if (statusEl) statusEl.innerHTML = '<p style="color:var(--color-text-muted);">Demande annulée.</p>';
  }

  // ----------------------------------------------------------
  // Polling du statut de paiement (toutes les 5 s)
  // ----------------------------------------------------------
  function startPolling(uuid) {
    stopPolling();

    pollingInterval = setInterval(async function () {
      var res = await window.API.tpe.getPayment(uuid);

      if (res.error || !res.data) return;

      var payment = res.data.payment;

      if (payment && payment.status === 'paid') {
        stopPolling();

        var qrCard = document.getElementById('qrCard');
        if (qrCard) qrCard.style.display = 'none';

        var statusEl = document.getElementById('paymentStatus');
        if (statusEl) {
          statusEl.innerHTML = '<p style="color:var(--color-success); font-weight:600;">✔ Paiement reçu !</p>';
        }

        currentQrUuid = null;
        await loadBalance();
        await loadTpeHistory();
      }
    }, 5000);
  }

  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  // ----------------------------------------------------------
  // Historique TPE
  // API retourne { payments: [] } (pas { items: [] })
  // ----------------------------------------------------------
  async function loadTpeHistory() {
    var res = await window.API.tpe.getHistory({ limit: 10 });

    if (res.error || !res.data) return;

    var container = document.getElementById('tpeHistoryList');
    if (!container) return;

    // L'API retourne { payments: [] }
    var payments = res.data.payments || [];

    if (payments.length === 0) {
      container.innerHTML = '<p style="color:var(--color-text-muted); text-align:center;">Aucun paiement</p>';
      return;
    }

    container.innerHTML = payments.map(function (p) {
      var statusColor = p.status === 'paid' ? 'var(--color-success)' : 'var(--color-text-muted)';
      return `
        <div style="
          display:flex; justify-content:space-between; align-items:center;
          padding: 8px 0; border-bottom: 1px solid var(--color-border);
        ">
          <div>
            <span style="font-weight:500;">${escHtml(p.label || 'Paiement')}</span>
            <span style="margin-left:8px; font-size:0.8rem; color:${statusColor};">[${escHtml(p.status)}]</span>
          </div>
          <strong>${formatMoney(p.amount)}</strong>
        </div>
      `;
    }).join('');
  }

  // ----------------------------------------------------------
  // PAGE DE PAIEMENT (tpe-pay.html)
  // Charge les détails du QR et permet à l'utilisateur de payer.
  // ----------------------------------------------------------
  async function initPayPage() {
    var params  = new URLSearchParams(window.location.search);
    var qrUuid  = params.get('qr');

    var loadingEl = document.getElementById('loadingState');
    var errorEl   = document.getElementById('errorState');
    var errorText = document.getElementById('errorText');
    var cardEl    = document.getElementById('paymentCard');
    var successEl = document.getElementById('successState');

    function showState(state) {
      if (loadingEl) loadingEl.style.display = state === 'loading'  ? '' : 'none';
      if (errorEl)   errorEl.style.display   = state === 'error'    ? '' : 'none';
      if (cardEl)    cardEl.style.display     = state === 'payment'  ? '' : 'none';
      if (successEl) successEl.style.display  = state === 'success'  ? '' : 'none';
    }

    if (!qrUuid) {
      showState('error');
      if (errorText) errorText.textContent = 'QR code invalide ou manquant.';
      return;
    }

    showState('loading');

    // Vérifier la connexion
    var meRes = await window.API.auth.me();
    if (meRes.error || !meRes.data) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.href);
      return;
    }

    var currentUser = meRes.data.user;

    // Charger les détails du paiement
    var res = await window.API.tpe.getPayment(qrUuid);

    if (res.error || !res.data) {
      showState('error');
      if (errorText) errorText.textContent = res.error || 'Paiement introuvable.';
      return;
    }

    var payment = res.data.payment;

    if (payment.status !== 'pending') {
      showState('error');
      if (errorText) errorText.textContent = 'Ce paiement n\'est plus disponible (statut : ' + payment.status + ').';
      return;
    }

    // Afficher les détails
    var merchantEl = document.getElementById('merchantName');
    var amountEl   = document.getElementById('amount');
    var labelEl    = document.getElementById('label');
    var balanceEl  = document.getElementById('userBalance');

    if (merchantEl) merchantEl.textContent = payment.merchant ? payment.merchant.displayName : '-';
    if (amountEl)   amountEl.textContent   = formatMoney(payment.amount);
    if (labelEl)    labelEl.textContent    = payment.label || '-';

    // Charger le solde courant
    var balRes = await window.API.account.getBalance();
    if (!balRes.error && balRes.data && balanceEl) {
      balanceEl.textContent = formatMoney(balRes.data.balance || 0);
    }

    showState('payment');

    // Bouton de paiement
    var payBtn = document.getElementById('payBtn');
    if (payBtn) {
      payBtn.addEventListener('click', async function () {
        payBtn.disabled = true;
        payBtn.textContent = 'Traitement...';

        var payRes = await window.API.tpe.pay(qrUuid);

        if (payRes.error || !payRes.data) {
          payBtn.disabled = false;
          payBtn.textContent = 'Payer maintenant';
          alert(payRes.error || 'Erreur lors du paiement.');
          return;
        }

        showState('success');
      });
    }
  }

  // ----------------------------------------------------------
  // Détection de la page et initialisation
  // ----------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('generateQrBtn')) {
      // Page tpe.html (commerçant)
      initTpePage();
    } else if (document.getElementById('payBtn') || document.getElementById('loadingState')) {
      // Page tpe-pay.html (paiement)
      initPayPage();
    }
  });
})();
