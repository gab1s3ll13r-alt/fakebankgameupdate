// ============================================================
// routes/admin.js
// Routes reservees aux administrateurs : controle total de la
// plateforme.
//
// Pouvoirs admin :
// - Creer et supprimer des comptes
// - Modifier les soldes
// - Attribuer/retirer le role Employe de banque
// - Attribuer/retirer l'acces TPE
// - Modifier tous les roles
// - Consulter toutes les operations
// - Consulter les journaux d'activite
// - Gerer les banques (parametres systeme)
// - Geler/degeler des comptes
//
// Toutes les routes de ce fichier sont protegees par
// requireAdmin (en plus de requireAuth).
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');

const { db, createAccountForUser, getAllBanks, logActivity } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');
const { formatIban, maskIban } = require('../utils/iban');
const logger = require('../utils/logger');

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// Toutes les routes de ce fichier sont reservees aux administrateurs
router.use(requireAuth, requireAdmin);

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Convertit un montant en euros en centimes (entier). Accepte
 * les valeurs negatives (pour ajustement de solde a la baisse),
 * mais pas zero ni NaN.
 *
 * @param {*} value
 * @returns {number|null}
 */
function toSignedCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) {
    return null;
  }
  return Math.round(num * 100);
}

/**
 * Convertit un montant en euros en centimes (entier positif uniquement).
 * @param {*} value
 * @returns {number|null}
 */
function toPositiveCents(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.round(num * 100);
}

/**
 * Serialise un utilisateur (avec compte) pour la reponse admin.
 * Inclut des champs non exposes aux autres roles (email, role,
 * has_tpe, is_active...).
 *
 * @param {object} row - ligne jointe users + accounts + banks
 * @returns {object}
 */
function serializeFullUser(row) {
  return {
    id: row.user_id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    hasTpe: !!row.has_tpe,
    tpeLabel: row.tpe_label,
    isActive: !!row.is_active,
    createdAt: row.user_created_at,
    updatedAt: row.user_updated_at,
    account: row.account_id
      ? {
          id: row.account_id,
          iban: row.iban,
          ibanFormatted: formatIban(row.iban),
          balance: row.balance,
          currency: row.currency,
          isFrozen: !!row.is_frozen,
          bank: { name: row.bank_name, code: row.bank_code },
        }
      : null,
  };
}

const FULL_USER_SELECT = `
  SELECT
    u.id AS user_id, u.username, u.email, u.display_name, u.role, u.has_tpe, u.tpe_label, u.is_active,
    u.created_at AS user_created_at, u.updated_at AS user_updated_at,
    a.id AS account_id, a.iban, a.balance, a.currency, a.is_frozen,
    b.name AS bank_name, b.code AS bank_code
  FROM users u
  LEFT JOIN accounts a ON a.user_id = u.id
  LEFT JOIN banks b ON b.id = a.bank_id
`;

// ------------------------------------------------------------
// GET /api/admin/users
// Liste/recherche de tous les utilisateurs (avec leurs comptes).
// Supporte ?q= (recherche) et ?role= (filtre par role).
// ------------------------------------------------------------
router.get('/users', (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const offset = (page - 1) * limit;

  const rawQuery = (req.query.q || '').trim();
  const allowedRoles = ['user', 'employee', 'admin'];
  const roleFilter = allowedRoles.includes(req.query.role) ? req.query.role : null;

  const conditions = [];
  const params = [];

  if (rawQuery.length > 0) {
    const likeQuery = `%${rawQuery.toLowerCase()}%`;
    conditions.push('(LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ? OR LOWER(u.email) LIKE ?)');
    params.push(likeQuery, likeQuery, likeQuery);
  }

  if (roleFilter) {
    conditions.push('u.role = ?');
    params.push(roleFilter);
  }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) AS total FROM users u WHERE ${whereClause}`).get(...params).total;

  const rows = db.prepare(`
    ${FULL_USER_SELECT}
    WHERE ${whereClause}
    ORDER BY u.username ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({
    users: rows.map(serializeFullUser),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

// ------------------------------------------------------------
// GET /api/admin/users/:id
// Detail complet d'un utilisateur.
// ------------------------------------------------------------
router.get('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'ID utilisateur invalide.' });
  }

  const row = db.prepare(`${FULL_USER_SELECT} WHERE u.id = ?`).get(userId);
  if (!row) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  return res.json({ user: serializeFullUser(row) });
});

// ------------------------------------------------------------
// POST /api/admin/users
// Cree un nouvel utilisateur (avec compte bancaire associe),
// en specifiant directement son role et son acces TPE.
// ------------------------------------------------------------
router.post(
  '/users',
  [
    body('username')
      .trim()
      .isLength({ min: 3, max: 30 })
      .withMessage('Le nom d\'utilisateur doit contenir entre 3 et 30 caracteres.')
      .matches(/^[a-zA-Z0-9_.-]+$/)
      .withMessage('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres, points, tirets et underscores.'),
    body('email').trim().isEmail().withMessage('Adresse email invalide.').normalizeEmail(),
    body('displayName')
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('Le nom affiche doit contenir entre 2 et 50 caracteres.'),
    body('password')
      .isLength({ min: 8, max: 100 })
      .withMessage('Le mot de passe doit contenir au moins 8 caracteres.')
      .matches(/[A-Za-z]/)
      .withMessage('Le mot de passe doit contenir au moins une lettre.')
      .matches(/[0-9]/)
      .withMessage('Le mot de passe doit contenir au moins un chiffre.'),
    body('role')
      .optional()
      .isIn(['user', 'employee', 'admin'])
      .withMessage('Role invalide.'),
    body('hasTpe').optional().isBoolean().withMessage('hasTpe doit etre un booleen.'),
    body('tpeLabel')
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage('Le libelle TPE ne peut pas depasser 100 caracteres.'),
    body('initialBalance').optional(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { username, email, displayName, password } = req.body;
    const role = req.body.role || 'user';
    const hasTpe = req.body.hasTpe ? 1 : 0;
    const tpeLabel = req.body.tpeLabel || null;

    let initialBalanceCents = 0;
    if (req.body.initialBalance !== undefined && req.body.initialBalance !== '') {
      const num = Number(req.body.initialBalance);
      if (!Number.isFinite(num) || num < 0) {
        return res.status(400).json({ error: 'Le solde initial doit etre un nombre positif ou nul.' });
      }
      initialBalanceCents = Math.round(num * 100);
    }

    const existingUsername = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (existingUsername) {
      return res.status(409).json({ error: 'Ce nom d\'utilisateur est deja pris.' });
    }

    const existingEmail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'Cette adresse email est deja utilisee.' });
    }

    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    let userId;

    try {
      const insertUser = db.prepare(`
        INSERT INTO users (username, email, password_hash, display_name, role, has_tpe, tpe_label, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const info = insertUser.run(username, email, passwordHash, displayName, role, hasTpe, tpeLabel);
      userId = info.lastInsertRowid;
    } catch (err) {
      logger.error('Erreur lors de la creation de l\'utilisateur (admin)', { error: err });
      return res.status(500).json({ error: 'Erreur interne lors de la creation du compte.' });
    }

    try {
      createAccountForUser(userId, initialBalanceCents);
    } catch (err) {
      logger.error('Erreur lors de la creation du compte bancaire (admin)', { error: err, userId });
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      return res.status(500).json({ error: 'Erreur interne lors de la creation du compte bancaire.' });
    }

    logActivity({
      actorUserId: req.user.id,
      action: 'admin_create_user',
      targetUserId: userId,
      details: { username, email, role, hasTpe: !!hasTpe, initialBalanceCents },
      ipAddress: req.ip,
    });

    const row = db.prepare(`${FULL_USER_SELECT} WHERE u.id = ?`).get(userId);

    return res.status(201).json({ message: 'Utilisateur cree avec succes.', user: serializeFullUser(row) });
  }
);

// ------------------------------------------------------------
// DELETE /api/admin/users/:id
// Supprime definitivement un utilisateur (et son compte, via
// ON DELETE CASCADE). Un admin ne peut pas se supprimer
// lui-meme, et le dernier admin du systeme ne peut pas etre
// supprime.
// ------------------------------------------------------------
router.delete('/users/:id', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (Number.isNaN(userId)) {
    return res.status(400).json({ error: 'ID utilisateur invalide.' });
  }

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  if (target.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Impossible de supprimer le dernier administrateur du systeme.' });
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  logActivity({
    actorUserId: req.user.id,
    action: 'admin_delete_user',
    targetUserId: userId,
    details: { username: target.username, email: target.email, role: target.role },
    ipAddress: req.ip,
  });

  logger.info('Utilisateur supprime par admin', { adminId: req.user.id, deletedUserId: userId });

  return res.json({ message: 'Utilisateur supprime avec succes.' });
});

// ------------------------------------------------------------
// PUT /api/admin/users/:id/role
// Modifie le role d'un utilisateur ('user' | 'employee' | 'admin').
// Empeche de retirer le dernier admin.
// ------------------------------------------------------------
router.put(
  '/users/:id/role',
  [
    body('role').isIn(['user', 'employee', 'admin']).withMessage('Role invalide.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const { role } = req.body;

    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Impossible de retirer le role admin du dernier administrateur.' });
      }
    }

    db.prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?").run(role, userId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
      VALUES (?, 'info', 'Role modifie', ?, NULL)
    `).run(userId, `Votre role a ete modifie : ${role}.`);

    logActivity({
      actorUserId: req.user.id,
      action: 'admin_change_role',
      targetUserId: userId,
      details: { previousRole: target.role, newRole: role },
      ipAddress: req.ip,
    });

    logger.info('Role modifie par admin', { adminId: req.user.id, targetUserId: userId, newRole: role });

    return res.json({ message: `Role mis a jour : ${role}.` });
  }
);

// ------------------------------------------------------------
// PUT /api/admin/users/:id/tpe
// Attribue ou retire l'acces TPE (has_tpe), avec libelle optionnel
// (nom du commerce affiche sur l'interface TPE).
// ------------------------------------------------------------
router.put(
  '/users/:id/tpe',
  [
    body('hasTpe').isBoolean().withMessage('hasTpe doit etre un booleen.'),
    body('tpeLabel')
      .optional({ nullable: true })
      .trim()
      .isLength({ max: 100 })
      .withMessage('Le libelle TPE ne peut pas depasser 100 caracteres.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const hasTpe = req.body.hasTpe ? 1 : 0;
    const tpeLabel = hasTpe ? (req.body.tpeLabel || target.tpe_label || target.display_name) : null;

    db.prepare("UPDATE users SET has_tpe = ?, tpe_label = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hasTpe, tpeLabel, userId);

    db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
      VALUES (?, 'info', 'Acces TPE modifie', ?, NULL)
    `).run(
      userId,
      hasTpe ? 'Vous avez maintenant acces a un terminal de paiement (TPE).' : 'Votre acces au terminal de paiement (TPE) a ete retire.'
    );

    logActivity({
      actorUserId: req.user.id,
      action: 'admin_change_tpe_access',
      targetUserId: userId,
      details: { hasTpe: !!hasTpe, tpeLabel },
      ipAddress: req.ip,
    });

    return res.json({ message: hasTpe ? 'Acces TPE accorde.' : 'Acces TPE retire.' });
  }
);

// ------------------------------------------------------------
// PUT /api/admin/users/:id/status
// Active ou desactive (gele l'acces) un compte utilisateur.
// ------------------------------------------------------------
router.put(
  '/users/:id/status',
  [
    body('isActive').isBoolean().withMessage('isActive doit etre un booleen.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const userId = parseInt(req.params.id, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Vous ne pouvez pas desactiver votre propre compte.' });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const isActive = req.body.isActive ? 1 : 0;

    if (target.role === 'admin' && isActive === 0) {
      const activeAdminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get().count;
      if (activeAdminCount <= 1) {
        return res.status(400).json({ error: 'Impossible de desactiver le dernier administrateur actif.' });
      }
    }

    db.prepare("UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?").run(isActive, userId);

    logActivity({
      actorUserId: req.user.id,
      action: isActive ? 'admin_activate_user' : 'admin_deactivate_user',
      targetUserId: userId,
      details: null,
      ipAddress: req.ip,
    });

    return res.json({ message: isActive ? 'Compte active.' : 'Compte desactive.' });
  }
);

// ------------------------------------------------------------
// PUT /api/admin/accounts/:userId/freeze
// Gele ou degele le compte bancaire d'un utilisateur (bloque
// virements et paiements TPE pour ce compte).
// ------------------------------------------------------------
router.put(
  '/accounts/:userId/freeze',
  [
    body('isFrozen').isBoolean().withMessage('isFrozen doit etre un booleen.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    const account = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
    if (!account) {
      return res.status(404).json({ error: 'Compte introuvable.' });
    }

    const isFrozen = req.body.isFrozen ? 1 : 0;

    db.prepare("UPDATE accounts SET is_frozen = ?, updated_at = datetime('now') WHERE id = ?")
      .run(isFrozen, account.id);

    db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
      VALUES (?, 'warning', 'Statut du compte modifie', ?, NULL)
    `).run(
      userId,
      isFrozen ? 'Votre compte a ete gele par un administrateur.' : 'Votre compte a ete degele.'
    );

    logActivity({
      actorUserId: req.user.id,
      action: isFrozen ? 'admin_freeze_account' : 'admin_unfreeze_account',
      targetUserId: userId,
      details: null,
      ipAddress: req.ip,
    });

    return res.json({ message: isFrozen ? 'Compte gele.' : 'Compte degele.' });
  }
);

// ------------------------------------------------------------
// POST /api/admin/accounts/:userId/adjust
// Ajuste directement le solde d'un compte (positif ou negatif),
// sans contrainte de solde suffisant (l'admin controle tout).
// Cree une ligne transactions de type 'admin_adjust'.
// ------------------------------------------------------------
router.post(
  '/accounts/:userId/adjust',
  [
    body('amount').notEmpty().withMessage('Montant requis.'),
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

    const userId = parseInt(req.params.userId, 10);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'ID utilisateur invalide.' });
    }

    const amountCents = toSignedCents(req.body.amount);
    if (amountCents === null) {
      return res.status(400).json({ error: 'Le montant doit etre un nombre different de zero.' });
    }

    const account = db.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
    if (!account) {
      return res.status(404).json({ error: 'Compte introuvable.' });
    }

    const description = req.body.description || `Ajustement de solde par l'administrateur ${req.user.display_name}`;
    const txUuid = uuidv4();
    const isCredit = amountCents > 0;
    const absAmount = Math.abs(amountCents);

    let result;

    try {
      const runAdjust = db.transaction(() => {
        const newBalance = account.balance + amountCents;

        db.prepare("UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?")
          .run(newBalance, account.id);

        const insertTx = db.prepare(`
          INSERT INTO transactions (
            uuid, type, from_account_id, to_account_id, amount,
            balance_after_from, balance_after_to, description, status, performed_by
          ) VALUES (?, 'admin_adjust', ?, ?, ?, ?, ?, ?, 'completed', ?)
        `);

        const txInfo = insertTx.run(
          txUuid,
          isCredit ? null : account.id,
          isCredit ? account.id : null,
          absAmount,
          isCredit ? null : newBalance,
          isCredit ? newBalance : null,
          description,
          req.user.id
        );

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, related_transaction_id)
          VALUES (?, ?, 'Ajustement de solde', ?, ?)
        `).run(
          userId,
          isCredit ? 'success' : 'warning',
          `Votre solde a ete ajuste de ${isCredit ? '+' : '-'}${(absAmount / 100).toFixed(2)} EUR par un administrateur.`,
          txInfo.lastInsertRowid
        );

        return { transactionId: txInfo.lastInsertRowid, newBalance };
      });

      result = runAdjust();
    } catch (err) {
      logger.error('Erreur lors de l\'ajustement de solde', { error: err, adminId: req.user.id, targetUserId: userId });
      return res.status(500).json({ error: 'Erreur interne lors de l\'operation.' });
    }

    logActivity({
      actorUserId: req.user.id,
      action: 'admin_adjust_balance',
      targetUserId: userId,
      details: { amountCents, transactionId: result.transactionId, description },
      ipAddress: req.ip,
    });

    logger.info('Ajustement de solde par admin', { adminId: req.user.id, targetUserId: userId, amountCents });

    return res.status(201).json({
      message: `Solde ajuste de ${isCredit ? '+' : '-'}${(absAmount / 100).toFixed(2)} EUR.`,
      transactionId: result.transactionId,
      newBalance: result.newBalance,
    });
  }
);

// ------------------------------------------------------------
// GET /api/admin/transactions
// Consultation de TOUTES les operations du systeme, avec
// pagination et filtres optionnels (?type=, ?userId=).
// ------------------------------------------------------------
router.get('/transactions', (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = (page - 1) * limit;

  const allowedTypes = ['transfer', 'tpe_payment', 'manual_credit', 'manual_debit', 'admin_adjust'];
  const typeFilter = allowedTypes.includes(req.query.type) ? req.query.type : null;
  const userIdFilter = req.query.userId ? parseInt(req.query.userId, 10) : null;

  const conditions = [];
  const params = [];

  if (typeFilter) {
    conditions.push('t.type = ?');
    params.push(typeFilter);
  }

  if (userIdFilter && !Number.isNaN(userIdFilter)) {
    conditions.push('(fa.user_id = ? OR ta.user_id = ?)');
    params.push(userIdFilter, userIdFilter);
  }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM transactions t
    LEFT JOIN accounts fa ON fa.id = t.from_account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    WHERE ${whereClause}
  `).get(...params).total;

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
    WHERE ${whereClause}
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({
    transactions: rows.map((tx) => ({
      id: tx.id,
      uuid: tx.uuid,
      type: tx.type,
      amount: tx.amount,
      description: tx.description,
      status: tx.status,
      createdAt: tx.created_at,
      balanceAfterFrom: tx.balance_after_from,
      balanceAfterTo: tx.balance_after_to,
      from: tx.from_user_id
        ? { userId: tx.from_user_id, username: tx.from_username, displayName: tx.from_display_name, ibanMasked: maskIban(tx.from_iban) }
        : null,
      to: tx.to_user_id
        ? { userId: tx.to_user_id, username: tx.to_username, displayName: tx.to_display_name, ibanMasked: maskIban(tx.to_iban) }
        : null,
      performedBy: tx.performed_by_username || null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

// ------------------------------------------------------------
// GET /api/admin/logs
// Consultation du journal d'activite (activity_logs), avec
// pagination et filtre optionnel par action (?action=).
// ------------------------------------------------------------
router.get('/logs', (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;

  const actionFilter = (req.query.action || '').trim();

  const conditions = [];
  const params = [];

  if (actionFilter.length > 0) {
    conditions.push('al.action = ?');
    params.push(actionFilter);
  }

  const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';

  const total = db.prepare(`SELECT COUNT(*) AS total FROM activity_logs al WHERE ${whereClause}`).get(...params).total;

  const rows = db.prepare(`
    SELECT
      al.id, al.action, al.details, al.ip_address, al.created_at,
      au.username AS actor_username, au.display_name AS actor_display_name,
      tu.username AS target_username, tu.display_name AS target_display_name
    FROM activity_logs al
    LEFT JOIN users au ON au.id = al.actor_user_id
    LEFT JOIN users tu ON tu.id = al.target_user_id
    WHERE ${whereClause}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return res.json({
    logs: rows.map((l) => ({
      id: l.id,
      action: l.action,
      details: l.details ? JSON.parse(l.details) : null,
      ipAddress: l.ip_address,
      createdAt: l.created_at,
      actor: l.actor_username ? { username: l.actor_username, displayName: l.actor_display_name } : null,
      target: l.target_username ? { username: l.target_username, displayName: l.target_display_name } : null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  });
});

// ------------------------------------------------------------
// GET /api/admin/banks
// Liste toutes les banques fictives disponibles.
// ------------------------------------------------------------
router.get('/banks', (req, res) => {
  const banks = getAllBanks();
  return res.json({ banks });
});

// ------------------------------------------------------------
// POST /api/admin/banks
// Cree une nouvelle banque fictive (permet d'ajouter
// ulterieurement plusieurs banques fictives).
// ------------------------------------------------------------
router.post(
  '/banks',
  [
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Le nom de la banque doit contenir entre 2 et 100 caracteres.'),
    body('code')
      .trim()
      .isLength({ min: 2, max: 4 })
      .withMessage('Le code banque doit contenir entre 2 et 4 caracteres.')
      .matches(/^[A-Za-z0-9]+$/)
      .withMessage('Le code banque ne peut contenir que des lettres et des chiffres.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { name } = req.body;
    const code = req.body.code.toUpperCase().padEnd(4, '0').slice(0, 4);

    const existing = db.prepare('SELECT 1 FROM banks WHERE code = ?').get(code);
    if (existing) {
      return res.status(409).json({ error: 'Une banque avec ce code existe deja.' });
    }

    const info = db.prepare('INSERT INTO banks (name, code) VALUES (?, ?)').run(name, code);

    logActivity({
      actorUserId: req.user.id,
      action: 'admin_create_bank',
      targetUserId: null,
      details: { name, code },
      ipAddress: req.ip,
    });

    const bank = db.prepare('SELECT * FROM banks WHERE id = ?').get(info.lastInsertRowid);

    return res.status(201).json({ message: 'Banque creee avec succes.', bank });
  }
);

// ------------------------------------------------------------
// GET /api/admin/stats
// Statistiques globales pour le tableau de bord admin
// (nombre d'utilisateurs, total des soldes, repartition des
// roles, transactions du jour, etc.)
// ------------------------------------------------------------
router.get('/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const totalActiveUsers = db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_active = 1').get().count;

  const roleBreakdown = db.prepare(`
    SELECT role, COUNT(*) AS count FROM users GROUP BY role
  `).all();

  const tpeCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE has_tpe = 1').get().count;

  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) AS total FROM accounts').get().total;

  const totalTransactions = db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count;

  const todayTransactions = db.prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE date(created_at) = date('now')
  `).get().count;

  const transactionsByType = db.prepare(`
    SELECT type, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total_amount
    FROM transactions
    WHERE status = 'completed'
    GROUP BY type
  `).all();

  return res.json({
    totalUsers,
    totalActiveUsers,
    roleBreakdown: roleBreakdown.reduce((acc, r) => {
      acc[r.role] = r.count;
      return acc;
    }, {}),
    tpeCount,
    totalBalance,
    totalTransactions,
    todayTransactions,
    transactionsByType: transactionsByType.map((t) => ({
      type: t.type,
      count: t.count,
      totalAmount: t.total_amount,
    })),
  });
});

module.exports = router;
