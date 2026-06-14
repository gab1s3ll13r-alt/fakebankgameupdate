// ============================================================
// routes/employee.js
// Routes réservées aux employés de banque (+ admin) :
// - Consultation des comptes
// - Crédit / débit manuels
// - Gestion des demandes bancaires
//
// Toutes les routes sont protégées par requireEmployeeOrAdmin.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { db, logActivity } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { requireEmployeeOrAdmin } = require('../middleware/roles');
const { formatIban, maskIban } = require('../utils/iban');
const logger = require('../utils/logger');

const router = express.Router();

// Toutes les routes de ce fichier sont réservées aux employés et admins
router.use(requireAuth, requireEmployeeOrAdmin);

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function toPositiveCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num * 100);
}

function serializeAccount(row) {
  return {
    userId:      row.user_id,
    username:    row.username,
    displayName: row.display_name,
    email:       row.email,
    role:        row.role,
    isActive:    !!row.is_active,
    account: row.account_id ? {
      id:           row.account_id,
      iban:         row.iban,
      ibanFormatted: formatIban(row.iban),
      ibanMasked:   maskIban(row.iban),
      balance:      row.balance,
      currency:     row.currency,
      isFrozen:     !!row.is_frozen,
      bank:         { name: row.bank_name, code: row.bank_code },
    } : null,
  };
}

const ACCOUNT_SELECT = `
  SELECT
    u.id AS user_id, u.username, u.display_name, u.email, u.role, u.is_active,
    a.id AS account_id, a.iban, a.balance, a.currency, a.is_frozen,
    b.name AS bank_name, b.code AS bank_code
  FROM users u
  LEFT JOIN accounts a ON a.user_id = u.id
  LEFT JOIN banks b ON b.id = a.bank_id
`;

// ------------------------------------------------------------
// GET /api/employee/accounts
// Liste les comptes utilisateurs (avec recherche optionnelle).
// ------------------------------------------------------------
router.get('/accounts', (req, res) => {
  const rawQuery = (req.query.q || '').trim();
  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const conditions = [];
  const params     = [];

  if (rawQuery.length >= 2) {
    const like = `%${rawQuery.toLowerCase()}%`;
    conditions.push('(LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ? OR a.iban LIKE ?)');
    params.push(like, like, `%${rawQuery.toUpperCase()}%`);
  }

  const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) AS total FROM users u LEFT JOIN accounts a ON a.user_id = u.id WHERE ${where}`)
    .get(...params).total;

  const rows = db.prepare(`${ACCOUNT_SELECT} WHERE ${where} ORDER BY u.username ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  return res.json({
    accounts: rows.map(serializeAccount),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

// ------------------------------------------------------------
// GET /api/employee/accounts/:userId
// Détail d'un compte utilisateur.
// ------------------------------------------------------------
router.get('/accounts/:userId', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'ID utilisateur invalide.' });
  }

  const row = db.prepare(`${ACCOUNT_SELECT} WHERE u.id = ?`).get(userId);
  if (!row) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  return res.json({ account: serializeAccount(row) });
});

// ------------------------------------------------------------
// GET /api/employee/accounts/:userId/transactions
// Historique des transactions d'un utilisateur.
// ------------------------------------------------------------
router.get('/accounts/:userId/transactions', (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'ID utilisateur invalide.' });
  }

  const account = db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(userId);
  if (!account) {
    return res.status(404).json({ error: 'Compte introuvable pour cet utilisateur.' });
  }

  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const total = db.prepare(
    'SELECT COUNT(*) AS total FROM transactions WHERE from_account_id = ? OR to_account_id = ?'
  ).get(account.id, account.id).total;

  const rows = db.prepare(`
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
    WHERE t.from_account_id = ? OR t.to_account_id = ?
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(account.id, account.id, limit, offset);

  const transactions = rows.map((tx) => ({
    id:          tx.id,
    uuid:        tx.uuid,
    type:        tx.type,
    amount:      tx.amount,
    description: tx.description,
    status:      tx.status,
    createdAt:   tx.created_at,
    from: tx.from_user_id ? {
      userId:      tx.from_user_id,
      username:    tx.from_username,
      displayName: tx.from_display_name,
      ibanMasked:  tx.from_iban ? maskIban(tx.from_iban) : null,
    } : null,
    to: tx.to_user_id ? {
      userId:      tx.to_user_id,
      username:    tx.to_username,
      displayName: tx.to_display_name,
      ibanMasked:  tx.to_iban ? maskIban(tx.to_iban) : null,
    } : null,
    performedBy: tx.performed_by_username || null,
  }));

  return res.json({
    transactions,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

// ------------------------------------------------------------
// POST /api/employee/accounts/:userId/credit
// Crédite le compte d'un utilisateur (opération manuelle).
// Crée une transaction de type 'manual_credit'.
// ------------------------------------------------------------
router.post(
  '/accounts/:userId/credit',
  [
    body('amount').notEmpty().withMessage('Montant requis.'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage('La description ne peut pas dépasser 200 caractères.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation échouée.', details: errors.array() });
    }

    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    const amountCents = toPositiveCents(req.body.amount);
    if (amountCents === null) {
      return res.status(400).json({ error: 'Le montant doit être un nombre positif.' });
    }

    const account = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
    if (!account) {
      return res.status(404).json({ error: 'Compte introuvable.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'Utilisateur introuvable ou inactif.' });
    }

    const description = (req.body.description || '').trim() ||
      `Crédit manuel par ${req.user.display_name} (@${req.user.username})`;
    const txUuid = uuidv4();

    let result;

    try {
      const runCredit = db.transaction(() => {
        const newBalance = account.balance + amountCents;

        db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newBalance, account.id);

        const txInfo = db.prepare(`
          INSERT INTO transactions (
            uuid, type, from_account_id, to_account_id, amount,
            balance_after_from, balance_after_to, description, status, performed_by
          ) VALUES (?, 'manual_credit', NULL, ?, ?, NULL, ?, ?, 'completed', ?)
        `).run(txUuid, account.id, amountCents, newBalance, description, req.user.id);

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
          VALUES (?, 'success', 'Crédit manuel', ?, ?)
        `).run(
          userId,
          `Votre compte a été crédité de ${(amountCents / 100).toFixed(2)} EUR par un employé de banque.`,
          txInfo.lastInsertRowid
        );

        return { transactionId: txInfo.lastInsertRowid, newBalance };
      });

      result = runCredit();
    } catch (err) {
      logger.error('Erreur crédit manuel', { error: err, employeeId: req.user.id, targetUserId: userId });
      return res.status(500).json({ error: 'Erreur interne lors du crédit.' });
    }

    logActivity({
      actorUserId:  req.user.id,
      action:       'employee_manual_credit',
      targetUserId: userId,
      details:      { amountCents, transactionId: result.transactionId, description },
      ipAddress:    req.ip,
    });

    logger.info('Crédit manuel employé', {
      employeeId: req.user.id,
      targetUserId: userId,
      amountCents,
    });

    return res.status(201).json({
      message:       `Compte crédité de ${(amountCents / 100).toFixed(2)} EUR.`,
      transactionId: result.transactionId,
      newBalance:    result.newBalance,
    });
  }
);

// ------------------------------------------------------------
// POST /api/employee/accounts/:userId/debit
// Débite le compte d'un utilisateur (opération manuelle).
// Crée une transaction de type 'manual_debit'.
// ------------------------------------------------------------
router.post(
  '/accounts/:userId/debit',
  [
    body('amount').notEmpty().withMessage('Montant requis.'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage('La description ne peut pas dépasser 200 caractères.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation échouée.', details: errors.array() });
    }

    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    const amountCents = toPositiveCents(req.body.amount);
    if (amountCents === null) {
      return res.status(400).json({ error: 'Le montant doit être un nombre positif.' });
    }

    const account = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
    if (!account) {
      return res.status(404).json({ error: 'Compte introuvable.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) {
      return res.status(404).json({ error: 'Utilisateur introuvable ou inactif.' });
    }

    if (account.balance < amountCents) {
      return res.status(400).json({ error: 'Solde insuffisant pour effectuer ce débit.' });
    }

    const description = (req.body.description || '').trim() ||
      `Débit manuel par ${req.user.display_name} (@${req.user.username})`;
    const txUuid = uuidv4();

    let result;

    try {
      const runDebit = db.transaction(() => {
        const newBalance = account.balance - amountCents;

        db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newBalance, account.id);

        const txInfo = db.prepare(`
          INSERT INTO transactions (
            uuid, type, from_account_id, to_account_id, amount,
            balance_after_from, balance_after_to, description, status, performed_by
          ) VALUES (?, 'manual_debit', ?, NULL, ?, ?, NULL, ?, 'completed', ?)
        `).run(txUuid, account.id, amountCents, newBalance, description, req.user.id);

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
          VALUES (?, 'warning', 'Débit manuel', ?, ?)
        `).run(
          userId,
          `Votre compte a été débité de ${(amountCents / 100).toFixed(2)} EUR par un employé de banque.`,
          txInfo.lastInsertRowid
        );

        return { transactionId: txInfo.lastInsertRowid, newBalance };
      });

      result = runDebit();
    } catch (err) {
      logger.error('Erreur débit manuel', { error: err, employeeId: req.user.id, targetUserId: userId });
      return res.status(500).json({ error: 'Erreur interne lors du débit.' });
    }

    logActivity({
      actorUserId:  req.user.id,
      action:       'employee_manual_debit',
      targetUserId: userId,
      details:      { amountCents, transactionId: result.transactionId, description },
      ipAddress:    req.ip,
    });

    logger.info('Débit manuel employé', {
      employeeId: req.user.id,
      targetUserId: userId,
      amountCents,
    });

    return res.status(201).json({
      message:       `Compte débité de ${(amountCents / 100).toFixed(2)} EUR.`,
      transactionId: result.transactionId,
      newBalance:    result.newBalance,
    });
  }
);

// ------------------------------------------------------------
// GET /api/employee/requests
// Liste les demandes bancaires (tous utilisateurs).
// Filtre optionnel par statut (?status=open|in_progress|resolved|rejected).
// ------------------------------------------------------------
router.get('/requests', (req, res) => {
  const allowedStatuses = ['open', 'in_progress', 'resolved', 'rejected'];
  const statusFilter = allowedStatuses.includes(req.query.status) ? req.query.status : null;

  const page   = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const conditions = [];
  const params     = [];

  if (statusFilter) {
    conditions.push('br.status = ?');
    params.push(statusFilter);
  }

  const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) AS total FROM bank_requests br WHERE ${where}`)
    .get(...params).total;

  const rows = db.prepare(`
    SELECT
      br.id, br.type, br.subject, br.message, br.status, br.response,
      br.created_at, br.updated_at,
      u.id AS user_id, u.username, u.display_name,
      hu.username AS handled_by_username
    FROM bank_requests br
    JOIN users u ON u.id = br.user_id
    LEFT JOIN users hu ON hu.id = br.handled_by
    WHERE ${where}
    ORDER BY br.created_at DESC, br.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({
    requests: rows.map((r) => ({
      id:          r.id,
      type:        r.type,
      subject:     r.subject,
      message:     r.message,
      status:      r.status,
      response:    r.response,
      createdAt:   r.created_at,
      updatedAt:   r.updated_at,
      user: {
        id:          r.user_id,
        username:    r.username,
        displayName: r.display_name,
      },
      handledBy: r.handled_by_username || null,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  });
});

// ------------------------------------------------------------
// PUT /api/employee/requests/:id
// Met à jour le statut et la réponse d'une demande bancaire.
// ------------------------------------------------------------
router.put(
  '/requests/:id',
  [
    body('status')
      .isIn(['open', 'in_progress', 'resolved', 'rejected'])
      .withMessage('Statut invalide.'),
    body('response')
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('La réponse ne peut pas dépasser 1000 caractères.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation échouée.', details: errors.array() });
    }

    const requestId = parseInt(req.params.id, 10);
    if (Number.isNaN(requestId)) {
      return res.status(400).json({ error: 'ID de demande invalide.' });
    }

    const bankRequest = db.prepare('SELECT * FROM bank_requests WHERE id = ?').get(requestId);
    if (!bankRequest) {
      return res.status(404).json({ error: 'Demande introuvable.' });
    }

    const { status, response } = req.body;

    db.prepare(`
      UPDATE bank_requests
      SET status = ?, response = ?, handled_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, response || null, req.user.id, requestId);

    if (status === 'resolved' || status === 'rejected') {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
        VALUES (?, ?, 'Demande traitée', ?, NULL)
      `).run(
        bankRequest.user_id,
        status === 'resolved' ? 'success' : 'warning',
        `Votre demande "${bankRequest.subject}" a été ${status === 'resolved' ? 'résolue' : 'rejetée'}.`
      );
    }

    logActivity({
      actorUserId:  req.user.id,
      action:       'employee_update_request',
      targetUserId: bankRequest.user_id,
      details:      { requestId, status, response },
      ipAddress:    req.ip,
    });

    return res.json({ message: 'Demande mise à jour.' });
  }
);
