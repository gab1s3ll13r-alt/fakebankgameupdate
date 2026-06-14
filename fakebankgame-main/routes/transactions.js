// ============================================================
// routes/transactions.js
// Routes liees aux operations financieres "utilisateur" :
// virements entre utilisateurs et consultation de l'historique.
//
// La logique de transfert est transactionnelle (db.transaction)
// pour garantir la coherence des soldes (debit + credit + log
// + notification dans une seule transaction SQLite atomique).
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { db, logActivity } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { canViewUserData } = require('../middleware/roles');
const { maskIban, formatIban } = require('../utils/iban');
const logger = require('../utils/logger');

const router = express.Router();

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Convertit un montant en euros (nombre, eventuellement avec
 * decimales) en centimes (entier). Retourne null si invalide.
 *
 * @param {*} value
 * @returns {number|null}
 */
function toCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  // Arrondi pour eviter les erreurs de virgule flottante
  return Math.round(num * 100);
}

/**
 * Serialise une ligne de transaction pour la reponse JSON,
 * du point de vue de l'utilisateur "viewerId".
 *
 * @param {object} tx - ligne brute de la table transactions (avec jointures)
 * @param {number} viewerUserId - ID de l'utilisateur qui consulte
 * @returns {object}
 */
function serializeTransaction(tx, viewerUserId) {
  const isOutgoing = tx.from_user_id === viewerUserId;
  const isIncoming = tx.to_user_id === viewerUserId;

  let direction = 'neutral';
  if (isOutgoing && !isIncoming) direction = 'outgoing';
  else if (isIncoming && !isOutgoing) direction = 'incoming';

  return {
    id: tx.id,
    uuid: tx.uuid,
    type: tx.type,
    amount: tx.amount,
    description: tx.description,
    status: tx.status,
    direction,
    createdAt: tx.created_at,
    from: tx.from_user_id
      ? {
          userId: tx.from_user_id,
          username: tx.from_username,
          displayName: tx.from_display_name,
          ibanMasked: tx.from_iban ? maskIban(tx.from_iban) : null,
        }
      : null,
    to: tx.to_user_id
      ? {
          userId: tx.to_user_id,
          username: tx.to_username,
          displayName: tx.to_display_name,
          ibanMasked: tx.to_iban ? maskIban(tx.to_iban) : null,
        }
      : null,
    balanceAfter:
      direction === 'outgoing'
        ? tx.balance_after_from
        : direction === 'incoming'
        ? tx.balance_after_to
        : null,
    performedBy: tx.performed_by_username || null,
  };
}

const TRANSACTION_LIST_SELECT = `
  SELECT
    t.id, t.uuid, t.type, t.amount, t.description, t.status, t.created_at,
    t.balance_after_from, t.balance_after_to,
    fa.user_id AS from_user_id, fu.username AS from_username, fu.display_name AS from_display_name, fa.iban AS from_iban,
    ta.user_id AS to_user_id, tu.username AS to_username, tu.display_name AS to_display_name, ta.iban AS to_iban,
    pu.username AS performed_by_username
  FROM transactions t
  LEFT JOIN accounts fa ON fa.id = t.from_account_id
  LEFT JOIN users fu ON fu.id = fa.user_id
  LEFT JOIN accounts ta ON ta.id = t.to_account_id
  LEFT JOIN users tu ON tu.id = ta.user_id
  LEFT JOIN users pu ON pu.id = t.performed_by
`;

// ------------------------------------------------------------
// POST /api/transactions/transfer
// Effectue un virement de l'utilisateur connecte vers un autre
// utilisateur (identifie par son ID, obtenu via /api/users/search
// ou /api/users/lookup).
// ------------------------------------------------------------
router.post(
  '/transfer',
  requireAuth,
  [
    body('recipientId')
      .notEmpty()
      .withMessage('Destinataire requis.')
      .isInt({ min: 1 })
      .withMessage('Identifiant de destinataire invalide.')
      .toInt(),
    body('amount')
      .notEmpty()
      .withMessage('Montant requis.'),
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

    const { recipientId, description } = req.body;
    const amountCents = toCents(req.body.amount);

    if (amountCents === null) {
      return res.status(400).json({ error: 'Le montant doit etre un nombre positif.' });
    }

    if (recipientId === req.user.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas effectuer un virement vers votre propre compte.' });
    }

    const senderAccount = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(req.user.id);
    if (!senderAccount) {
      return res.status(404).json({ error: 'Compte bancaire introuvable pour l\'expediteur.' });
    }

    if (senderAccount.is_frozen) {
      return res.status(403).json({ error: 'Votre compte est gele. Les virements sont impossibles.' });
    }

    const recipient = db.prepare(`
      SELECT u.id AS user_id, u.username, u.display_name, u.is_active, a.id AS account_id, a.iban, a.is_frozen
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      WHERE u.id = ?
    `).get(recipientId);

    if (!recipient || !recipient.is_active) {
      return res.status(404).json({ error: 'Destinataire introuvable.' });
    }

    if (recipient.is_frozen) {
      return res.status(403).json({ error: 'Le compte du destinataire est gele. Le virement est impossible.' });
    }

    if (senderAccount.balance < amountCents) {
      return res.status(400).json({ error: 'Solde insuffisant pour effectuer ce virement.' });
    }

    const txUuid = uuidv4();
    const cleanDescription = description && description.length > 0 ? description : 'Virement entre utilisateurs';

    let result;

    try {
      const runTransfer = db.transaction(() => {
        const newSenderBalance = senderAccount.balance - amountCents;
        const newRecipientBalance = (db.prepare('SELECT balance FROM accounts WHERE id = ?').get(recipient.account_id)).balance + amountCents;

        db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newSenderBalance, senderAccount.id);

        db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newRecipientBalance, recipient.account_id);

        const insertTx = db.prepare(`
          INSERT INTO transactions (
            uuid, type, from_account_id, to_account_id, amount,
            balance_after_from, balance_after_to, description, status, performed_by
          ) VALUES (?, 'transfer', ?, ?, ?, ?, ?, ?, 'completed', ?)
        `);

        const txInfo = insertTx.run(
          txUuid,
          senderAccount.id,
          recipient.account_id,
          amountCents,
          newSenderBalance,
          newRecipientBalance,
          cleanDescription,
          req.user.id
        );

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
          VALUES (?, 'success', 'Virement recu', ?, ?)
        `).run(
          recipient.user_id,
          `Vous avez recu ${(amountCents / 100).toFixed(2)} EUR de ${req.user.display_name} (@${req.user.username}).`,
          txInfo.lastInsertRowid
        );

        return {
          transactionId: txInfo.lastInsertRowid,
          newSenderBalance,
          newRecipientBalance,
        };
      });

      result = runTransfer();
    } catch (err) {
      logger.error('Erreur lors du virement', { error: err, userId: req.user.id, recipientId });
      return res.status(500).json({ error: 'Erreur interne lors du virement. Aucun montant n\'a ete debite.' });
    }

    logActivity({
      actorUserId: req.user.id,
      action: 'transfer',
      targetUserId: recipient.user_id,
      details: {
        amountCents,
        transactionId: result.transactionId,
        uuid: txUuid,
      },
      ipAddress: req.ip,
    });

    logger.info('Virement effectue', {
      from: req.user.id,
      to: recipient.user_id,
      amountCents,
      transactionId: result.transactionId,
    });

    return res.status(201).json({
      message: `Virement de ${(amountCents / 100).toFixed(2)} EUR envoye a ${recipient.display_name}.`,
      transaction: {
        id: result.transactionId,
        uuid: txUuid,
        amount: amountCents,
        description: cleanDescription,
        recipient: {
          id: recipient.user_id,
          username: recipient.username,
          displayName: recipient.display_name,
          ibanMasked: maskIban(recipient.iban),
        },
      },
      newBalance: result.newSenderBalance,
    });
  }
);

// ------------------------------------------------------------
// GET /api/transactions/history
// Retourne l'historique des operations de l'utilisateur connecte
// (toutes les transactions ou son compte est emetteur ou
// destinataire). Supporte la pagination (?page, ?limit) et un
// filtre par type (?type=transfer|tpe_payment|...).
// ------------------------------------------------------------
router.get('/history', requireAuth, (req, res) => {
  const account = db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(req.user.id);

  if (!account) {
    return res.status(404).json({ error: 'Compte bancaire introuvable.' });
  }

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const allowedTypes = ['transfer', 'tpe_payment', 'manual_credit', 'manual_debit', 'admin_adjust'];
  const typeFilter = allowedTypes.includes(req.query.type) ? req.query.type : null;

  let whereClause = '(t.from_account_id = ? OR t.to_account_id = ?)';
  const params = [account.id, account.id];

  if (typeFilter) {
    whereClause += ' AND t.type = ?';
    params.push(typeFilter);
  }

  const countQuery = `SELECT COUNT(*) AS total FROM transactions t WHERE ${whereClause}`;
  const total = db.prepare(countQuery).get(...params).total;

  const listQuery = `${TRANSACTION_LIST_SELECT} WHERE ${whereClause} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(listQuery).all(...params, limit, offset);

  return res.json({
    transactions: rows.map((tx) => serializeTransaction(tx, req.user.id)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

// ------------------------------------------------------------
// GET /api/transactions/summary
// Retourne un resume agrege des transactions de l'utilisateur,
// utilise pour les graphiques du tableau de bord (entrees vs
// sorties par jour, sur les N derniers jours).
// ------------------------------------------------------------
router.get('/summary', requireAuth, (req, res) => {
  const account = db.prepare('SELECT id, balance FROM accounts WHERE user_id = ?').get(req.user.id);

  if (!account) {
    return res.status(404).json({ error: 'Compte bancaire introuvable.' });
  }

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);

  const rows = db.prepare(`
    SELECT
      date(t.created_at) AS day,
      SUM(CASE WHEN t.to_account_id = ? THEN t.amount ELSE 0 END) AS total_in,
      SUM(CASE WHEN t.from_account_id = ? THEN t.amount ELSE 0 END) AS total_out
    FROM transactions t
    WHERE (t.from_account_id = ? OR t.to_account_id = ?)
      AND t.status = 'completed'
      AND date(t.created_at) >= date('now', ?)
    GROUP BY date(t.created_at)
    ORDER BY day ASC
  `).all(account.id, account.id, account.id, account.id, `-${days} days`);

  return res.json({
    currentBalance: account.balance,
    days: rows.map((r) => ({
      date: r.day,
      totalIn: r.total_in || 0,
      totalOut: r.total_out || 0,
    })),
  });
});

// ------------------------------------------------------------
// GET /api/transactions/:id
// Retourne le detail d'une transaction specifique, si
// l'utilisateur connecte y est implique (emetteur ou
// destinataire), ou s'il est employe/admin (peuvent tout voir).
// ------------------------------------------------------------
router.get('/:id', requireAuth, (req, res) => {
  const txId = parseInt(req.params.id, 10);

  if (Number.isNaN(txId)) {
    return res.status(400).json({ error: 'ID de transaction invalide.' });
  }

  const tx = db.prepare(`${TRANSACTION_LIST_SELECT} WHERE t.id = ?`).get(txId);

  if (!tx) {
    return res.status(404).json({ error: 'Transaction introuvable.' });
  }

  const isInvolved = tx.from_user_id === req.user.id || tx.to_user_id === req.user.id;
  const canViewAny = canViewUserData(req.user, tx.from_user_id) || canViewUserData(req.user, tx.to_user_id);

  if (!isInvolved && !canViewAny) {
    return res.status(403).json({ error: 'Vous n\'avez pas la permission de consulter cette transaction.' });
  }

  return res.json({ transaction: serializeTransaction(tx, req.user.id) });
});

module.exports = router;
