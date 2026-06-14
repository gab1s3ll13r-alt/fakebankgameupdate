// ============================================================
// routes/tpe.js
// Routes du systeme TPE (Terminal de Paiement Electronique) :
// - Generation de demandes de paiement (QR code)
// - Encaissement direct (paiement immediat par un payeur)
// - Consultation et execution d'un QR code de paiement
// - Historique des paiements TPE du commercant
//
// Reserve aux utilisateurs avec has_tpe = 1 (ou admin) pour la
// CREATION de demandes de paiement. Le PAIEMENT d'un QR code,
// en revanche, peut etre effectue par n'importe quel utilisateur
// authentifie (c'est le payeur, pas forcement le commercant).
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { db, logActivity } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { requireTpeAccess } = require('../middleware/roles');
const { maskIban } = require('../utils/iban');
const logger = require('../utils/logger');

const router = express.Router();

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Convertit un montant en euros en centimes (entier positif).
 * Retourne null si invalide.
 *
 * @param {*} value
 * @returns {number|null}
 */
function toCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.round(num * 100);
}

/**
 * Serialise une demande de paiement TPE pour la reponse JSON.
 *
 * @param {object} row - ligne jointe tpe_payments + transactions + users
 * @returns {object}
 */
function serializeTpePayment(row) {
  return {
    id: row.id,
    qrCodeUuid: row.qr_code_uuid,
    status: row.qr_status,
    label: row.label,
    amount: row.amount,
    description: row.description,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    merchant: {
      id: row.merchant_user_id,
      username: row.merchant_username,
      displayName: row.merchant_display_name,
    },
    payer: row.payer_user_id
      ? {
          id: row.payer_user_id,
          username: row.payer_username,
          displayName: row.payer_display_name,
        }
      : null,
    transactionUuid: row.transaction_uuid,
  };
}

const TPE_PAYMENT_SELECT = `
  SELECT
    tp.id, tp.qr_code_uuid, tp.qr_status, tp.label, tp.created_at, tp.paid_at,
    tp.merchant_user_id, tp.payer_user_id, tp.transaction_id,
    t.uuid AS transaction_uuid, t.amount, t.description, t.status AS tx_status,
    mu.username AS merchant_username, mu.display_name AS merchant_display_name,
    pu.username AS payer_username, pu.display_name AS payer_display_name
  FROM tpe_payments tp
  JOIN transactions t ON t.id = tp.transaction_id
  JOIN users mu ON mu.id = tp.merchant_user_id
  LEFT JOIN users pu ON pu.id = tp.payer_user_id
`;

// ------------------------------------------------------------
// POST /api/tpe/request
// Cree une demande de paiement TPE (genere un QR code) pour un
// montant donne. Reserve aux utilisateurs avec acces TPE.
//
// La transaction n'est PAS encore effectuee : elle sera realisee
// quand un payeur scannera/validera le QR code via
// POST /api/tpe/pay/:qrCodeUuid
// ------------------------------------------------------------
router.post(
  '/request',
  requireAuth,
  requireTpeAccess,
  [
    body('amount').notEmpty().withMessage('Montant requis.'),
    body('label')
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Le libelle ne peut pas depasser 100 caracteres.'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage('La description ne peut pas depasser 200 caracteres.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const amountCents = toCents(req.body.amount);
    if (amountCents === null) {
      return res.status(400).json({ error: 'Le montant doit etre un nombre positif.' });
    }

    const merchantAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(req.user.id);
    if (!merchantAccount) {
      return res.status(404).json({ error: 'Compte bancaire introuvable.' });
    }

    if (merchantAccount.is_frozen) {
      return res.status(403).json({ error: 'Votre compte est gele. Impossible de creer une demande de paiement.' });
    }

    const txUuid = uuidv4();
    const qrUuid = uuidv4();
    const label = req.body.label || 'Paiement TPE';
    const description = req.body.description || `Paiement TPE - ${label}`;

    let paymentId;

    try {
      const runCreate = db.transaction(() => {
        // On cree d'abord une transaction "pending" sans mouvement de fonds.
        const insertTx = db.prepare(`
          INSERT INTO transactions (
            uuid, type, from_account_id, to_account_id, amount,
            balance_after_from, balance_after_to, description, status, performed_by
          ) VALUES (?, 'tpe_payment', NULL, ?, ?, NULL, NULL, ?, 'pending', ?)
        `);

        const txInfo = insertTx.run(txUuid, merchantAccount.id, amountCents, description, req.user.id);

        const insertTpe = db.prepare(`
          INSERT INTO tpe_payments (
            transaction_id, merchant_user_id, payer_user_id, label, qr_code_uuid, qr_status
          ) VALUES (?, ?, NULL, ?, ?, 'pending')
        `);

        const tpeInfo = insertTpe.run(txInfo.lastInsertRowid, req.user.id, label, qrUuid);

        return tpeInfo.lastInsertRowid;
      });

      paymentId = runCreate();
    } catch (err) {
      logger.error('Erreur lors de la creation de la demande TPE', { error: err, userId: req.user.id });
      return res.status(500).json({ error: 'Erreur interne lors de la creation de la demande de paiement.' });
    }

    logger.info('Demande de paiement TPE creee', { merchantId: req.user.id, amountCents, qrUuid });

    return res.status(201).json({
      message: 'Demande de paiement creee.',
      payment: {
        id: paymentId,
        qrCodeUuid: qrUuid,
        amount: amountCents,
        label,
        description,
        status: 'pending',
      },
    });
  }
);

// ------------------------------------------------------------
// GET /api/tpe/pay/:qrCodeUuid
// Retourne les details d'une demande de paiement TPE a partir
// de son identifiant QR (utilise par le payeur avant de
// confirmer le paiement, pour afficher "Vous allez payer X EUR
// a [commercant]").
//
// Accessible a tout utilisateur authentifie (le payeur n'est
// pas force d'avoir un TPE).
// ------------------------------------------------------------
router.get('/pay/:qrCodeUuid', requireAuth, (req, res) => {
  const qrUuid = req.params.qrCodeUuid;

  const row = db.prepare(`${TPE_PAYMENT_SELECT} WHERE tp.qr_code_uuid = ?`).get(qrUuid);

  if (!row) {
    return res.status(404).json({ error: 'Demande de paiement introuvable.' });
  }

  if (row.qr_status !== 'pending') {
    return res.status(409).json({
      error: `Cette demande de paiement n'est plus disponible (statut: ${row.qr_status}).`,
      payment: serializeTpePayment(row),
    });
  }

  if (row.merchant_user_id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas payer votre propre demande de paiement.' });
  }

  return res.json({ payment: serializeTpePayment(row) });
});

// ------------------------------------------------------------
// POST /api/tpe/pay/:qrCodeUuid
// Confirme et execute le paiement d'une demande TPE : debite le
// compte du payeur (utilisateur connecte) et credite le compte
// du commercant. Met a jour le statut du QR code a 'paid'.
//
// Operation atomique (db.transaction).
// ------------------------------------------------------------
router.post('/pay/:qrCodeUuid', requireAuth, (req, res) => {
  const qrUuid = req.params.qrCodeUuid;

  const row = db.prepare(`${TPE_PAYMENT_SELECT} WHERE tp.qr_code_uuid = ?`).get(qrUuid);

  if (!row) {
    return res.status(404).json({ error: 'Demande de paiement introuvable.' });
  }

  if (row.qr_status !== 'pending') {
    return res.status(409).json({ error: `Cette demande de paiement n'est plus disponible (statut: ${row.qr_status}).` });
  }

  if (row.merchant_user_id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas payer votre propre demande de paiement.' });
  }

  const payerAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(req.user.id);
  if (!payerAccount) {
    return res.status(404).json({ error: 'Compte bancaire introuvable.' });
  }

  if (payerAccount.is_frozen) {
    return res.status(403).json({ error: 'Votre compte est gele. Le paiement est impossible.' });
  }

  const merchantAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(row.merchant_user_id);
  if (!merchantAccount) {
    return res.status(404).json({ error: 'Compte du commercant introuvable.' });
  }

  if (merchantAccount.is_frozen) {
    return res.status(403).json({ error: 'Le compte du commercant est gele. Le paiement est impossible.' });
  }

  if (payerAccount.balance < row.amount) {
    return res.status(400).json({ error: 'Solde insuffisant pour effectuer ce paiement.' });
  }

  let result;

  try {
    const runPayment = db.transaction(() => {
      const newPayerBalance = payerAccount.balance - row.amount;
      const newMerchantBalance = (db.prepare('SELECT balance FROM accounts WHERE id = ?').get(merchantAccount.id)).balance + row.amount;

      db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newPayerBalance, payerAccount.id);

      db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newMerchantBalance, merchantAccount.id);

      db.prepare(`
        UPDATE transactions
        SET from_account_id = ?, status = 'completed',
            balance_after_from = ?, balance_after_to = ?
        WHERE id = ?
      `).run(payerAccount.id, newPayerBalance, newMerchantBalance, row.transaction_id);

      db.prepare(`
        UPDATE tpe_payments
        SET payer_user_id = ?, qr_status = 'paid', paid_at = datetime('now')
        WHERE qr_code_uuid = ?
      `).run(req.user.id, qrUuid);

      db.prepare(`
        INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
        VALUES (?, 'success', 'Paiement TPE recu', ?, ?)
      `).run(
        row.merchant_user_id,
        `${req.user.display_name} (@${req.user.username}) a paye ${(row.amount / 100).toFixed(2)} EUR via votre TPE.`,
        row.transaction_id
      );

      return {
        transactionId: row.transaction_id,
        newPayerBalance,
        newMerchantBalance,
      };
    });

    result = runPayment();
  } catch (err) {
    logger.error('Erreur lors du paiement TPE', { error: err, userId: req.user.id, qrUuid });
    return res.status(500).json({ error: 'Erreur interne lors du paiement. Aucun montant n\'a ete debite.' });
  }

  logActivity({
    actorUserId: req.user.id,
    action: 'tpe_payment',
    targetUserId: row.merchant_user_id,
    details: {
      amountCents: row.amount,
      transactionId: result.transactionId,
      qrUuid,
    },
    ipAddress: req.ip,
  });

  logger.info('Paiement TPE effectue', {
    payer: req.user.id,
    merchant: row.merchant_user_id,
    amountCents: row.amount,
    transactionId: result.transactionId,
  });

  return res.json({
    message: `Paiement de ${(row.amount / 100).toFixed(2)} EUR effectue avec succes.`,
    transactionId: result.transactionId,
    newBalance: result.newPayerBalance,
    merchant: {
      username: row.merchant_username,
      displayName: row.merchant_display_name,
    },
  });
});

// ------------------------------------------------------------
// POST /api/tpe/cancel/:qrCodeUuid
// Annule une demande de paiement TPE en attente. Reserve au
// commercant ayant cree la demande (ou a un admin).
// ------------------------------------------------------------
router.post('/cancel/:qrCodeUuid', requireAuth, requireTpeAccess, (req, res) => {
  const qrUuid = req.params.qrCodeUuid;

  const row = db.prepare(`${TPE_PAYMENT_SELECT} WHERE tp.qr_code_uuid = ?`).get(qrUuid);

  if (!row) {
    return res.status(404).json({ error: 'Demande de paiement introuvable.' });
  }

  if (row.merchant_user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Vous ne pouvez annuler que vos propres demandes de paiement.' });
  }

  if (row.qr_status !== 'pending') {
    return res.status(409).json({ error: `Cette demande ne peut pas etre annulee (statut: ${row.qr_status}).` });
  }

  db.prepare("UPDATE tpe_payments SET qr_status = 'cancelled' WHERE qr_code_uuid = ?").run(qrUuid);
  db.prepare("UPDATE transactions SET status = 'failed' WHERE id = ?").run(row.transaction_id);

  return res.json({ message: 'Demande de paiement annulee.' });
});

// ------------------------------------------------------------
// GET /api/tpe/history
// Retourne l'historique des paiements TPE du commercant
// connecte (toutes demandes, quel que soit leur statut),
// les plus recentes en premier. Reserve aux utilisateurs avec
// acces TPE.
// ------------------------------------------------------------
router.get('/history', requireAuth, requireTpeAccess, (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) AS total FROM tpe_payments WHERE merchant_user_id = ?')
    .get(req.user.id).total;

  const rows = db.prepare(`
    ${TPE_PAYMENT_SELECT}
    WHERE tp.merchant_user_id = ?
    ORDER BY tp.created_at DESC, tp.id DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  return res.json({
    payments: rows.map(serializeTpePayment),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

// ------------------------------------------------------------
// GET /api/tpe/pending
// Retourne les demandes de paiement actuellement en attente
// ('pending') pour le commercant connecte (utile pour afficher
// "demande en cours, en attente de paiement" sur l'interface TPE).
// ------------------------------------------------------------
router.get('/pending', requireAuth, requireTpeAccess, (req, res) => {
  const rows = db.prepare(`
    ${TPE_PAYMENT_SELECT}
    WHERE tp.merchant_user_id = ? AND tp.qr_status = 'pending'
    ORDER BY tp.created_at DESC
  `).all(req.user.id);

  return res.json({ payments: rows.map(serializeTpePayment) });
});

module.exports = router;
