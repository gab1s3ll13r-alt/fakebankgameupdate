// ============================================================
// routes/account.js
// Routes liees au compte bancaire de l'utilisateur connecte :
// consultation du solde, informations du compte, profil,
// notifications.
//
// Toutes les routes necessitent une authentification.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');

const { db } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { formatIban } = require('../utils/iban');
const logger = require('../utils/logger');

const router = express.Router();

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Recupere le compte bancaire associe a un utilisateur, avec
 * les informations de la banque.
 *
 * @param {number} userId
 * @returns {object|undefined}
 */
function getAccountByUserId(userId) {
  return db.prepare(`
    SELECT a.id, a.iban, a.balance, a.currency, a.is_frozen, a.created_at, a.updated_at,
           b.id AS bank_id, b.name AS bank_name, b.code AS bank_code
    FROM accounts a
    JOIN banks b ON b.id = a.bank_id
    WHERE a.user_id = ?
  `).get(userId);
}

/**
 * Serialise un compte pour la reponse JSON (IBAN formate inclus).
 *
 * @param {object} account - resultat de getAccountByUserId
 * @returns {object}
 */
function serializeAccount(account) {
  return {
    id: account.id,
    iban: account.iban,
    ibanFormatted: formatIban(account.iban),
    balance: account.balance,
    currency: account.currency,
    isFrozen: !!account.is_frozen,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
    bank: {
      id: account.bank_id,
      name: account.bank_name,
      code: account.bank_code,
    },
  };
}

// ------------------------------------------------------------
// GET /api/account
// Retourne le compte bancaire de l'utilisateur connecte
// (solde, IBAN, banque, statut).
// ------------------------------------------------------------
router.get('/', requireAuth, (req, res) => {
  const account = getAccountByUserId(req.user.id);

  if (!account) {
    return res.status(404).json({ error: 'Aucun compte bancaire associe a cet utilisateur.' });
  }

  return res.json({ account: serializeAccount(account) });
});

// ------------------------------------------------------------
// GET /api/account/balance
// Retourne uniquement le solde courant (utile pour des
// rafraichissements legers, ex: polling pour notifications).
// ------------------------------------------------------------
router.get('/balance', requireAuth, (req, res) => {
  const account = db.prepare('SELECT balance, currency, is_frozen FROM accounts WHERE user_id = ?').get(req.user.id);

  if (!account) {
    return res.status(404).json({ error: 'Aucun compte bancaire associe a cet utilisateur.' });
  }

  return res.json({
    balance: account.balance,
    currency: account.currency,
    isFrozen: !!account.is_frozen,
  });
});

// ------------------------------------------------------------
// GET /api/account/profile
// Retourne le profil complet de l'utilisateur connecte
// (informations personnelles + compte bancaire).
// ------------------------------------------------------------
router.get('/profile', requireAuth, (req, res) => {
  const account = getAccountByUserId(req.user.id);

  return res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      displayName: req.user.display_name,
      role: req.user.role,
      hasTpe: !!req.user.has_tpe,
      tpeLabel: req.user.tpe_label,
      isActive: !!req.user.is_active,
      createdAt: req.user.created_at,
    },
    account: account ? serializeAccount(account) : null,
  });
});

// ------------------------------------------------------------
// PUT /api/account/profile
// Permet a l'utilisateur connecte de modifier son nom affiche
// et/ou son adresse email.
// ------------------------------------------------------------
router.put(
  '/profile',
  requireAuth,
  [
    body('displayName')
      .optional()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('Le nom affiche doit contenir entre 2 et 50 caracteres.'),
    body('email')
      .optional()
      .trim()
      .isEmail()
      .withMessage('Adresse email invalide.')
      .normalizeEmail(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { displayName, email } = req.body;

    if (!displayName && !email) {
      return res.status(400).json({ error: 'Aucune modification fournie.' });
    }

    if (email) {
      const existingEmail = db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
      if (existingEmail) {
        return res.status(409).json({ error: 'Cette adresse email est deja utilisee par un autre compte.' });
      }
    }

    const updates = [];
    const params = [];

    if (displayName) {
      updates.push('display_name = ?');
      params.push(displayName);
    }

    if (email) {
      updates.push('email = ?');
      params.push(email);
    }

    updates.push("updated_at = datetime('now')");
    params.push(req.user.id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logger.info('Profil utilisateur mis a jour', { userId: req.user.id });

    const updatedUser = db.prepare(`
      SELECT id, username, email, display_name, role, has_tpe, tpe_label, is_active, created_at, updated_at
      FROM users WHERE id = ?
    `).get(req.user.id);

    return res.json({
      message: 'Profil mis a jour avec succes.',
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        displayName: updatedUser.display_name,
        role: updatedUser.role,
        hasTpe: !!updatedUser.has_tpe,
        tpeLabel: updatedUser.tpe_label,
        isActive: !!updatedUser.is_active,
        createdAt: updatedUser.created_at,
        updatedAt: updatedUser.updated_at,
      },
    });
  }
);

// ------------------------------------------------------------
// GET /api/account/notifications
// Retourne les notifications de l'utilisateur connecte
// (plus recentes en premier). Supporte un filtre ?unread=true
// et une limite ?limit=20.
// ------------------------------------------------------------
router.get('/notifications', requireAuth, (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

  let query = `
    SELECT id, type, title, message, related_transaction_id, is_read, created_at
    FROM notifications
    WHERE user_id = ?
  `;
  const params = [req.user.id];

  if (unreadOnly) {
    query += ' AND is_read = 0';
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const notifications = db.prepare(query).all(...params);

  const unreadCount = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0
  `).get(req.user.id).count;

  return res.json({
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      relatedTransactionId: n.related_transaction_id,
      isRead: !!n.is_read,
      createdAt: n.created_at,
    })),
    unreadCount,
  });
});

// ------------------------------------------------------------
// POST /api/account/notifications/:id/read
// Marque une notification specifique comme lue.
// ------------------------------------------------------------
router.post('/notifications/:id/read', requireAuth, (req, res) => {
  const notificationId = parseInt(req.params.id, 10);

  if (Number.isNaN(notificationId)) {
    return res.status(400).json({ error: 'ID de notification invalide.' });
  }

  const notification = db.prepare(`
    SELECT id FROM notifications WHERE id = ? AND user_id = ?
  `).get(notificationId, req.user.id);

  if (!notification) {
    return res.status(404).json({ error: 'Notification introuvable.' });
  }

  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(notificationId);

  return res.json({ message: 'Notification marquee comme lue.' });
});

// ------------------------------------------------------------
// POST /api/account/notifications/read-all
// Marque toutes les notifications de l'utilisateur comme lues.
// ------------------------------------------------------------
router.post('/notifications/read-all', requireAuth, (req, res) => {
  const result = db.prepare(`
    UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0
  `).run(req.user.id);

  return res.json({ message: 'Toutes les notifications ont ete marquees comme lues.', updated: result.changes });
});

module.exports = router;
