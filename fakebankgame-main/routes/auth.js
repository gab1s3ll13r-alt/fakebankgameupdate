// ============================================================
// routes/auth.js
// Routes d'authentification : inscription, connexion,
// deconnexion, recuperation de l'utilisateur courant.
//
// Toutes les reponses sont en JSON (API consommee via fetch).
// ============================================================

const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');

const { db, createAccountForUser, logActivity } = require('../database/db');
const { requireAuth, requireGuest, getUserById } = require('../middleware/auth');
const { formatIban } = require('../utils/iban');
const logger = require('../utils/logger');

const router = express.Router();

const BCRYPT_ROUNDS = 12;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Construit l'objet utilisateur "public" (sans hash de mot de
 * passe) avec ses informations de compte bancaire associees.
 *
 * @param {number} userId
 * @returns {object|null}
 */
function getUserWithAccount(userId) {
  const user = getUserById(userId);
  if (!user) return null;

  const account = db.prepare(`
    SELECT a.id, a.iban, a.balance, a.currency, a.is_frozen, b.name AS bank_name, b.code AS bank_code
    FROM accounts a
    JOIN banks b ON b.id = a.bank_id
    WHERE a.user_id = ?
  `).get(userId);

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    hasTpe: !!user.has_tpe,
    tpeLabel: user.tpe_label,
    isActive: !!user.is_active,
    createdAt: user.created_at,
    account: account
      ? {
          id: account.id,
          iban: account.iban,
          ibanFormatted: formatIban(account.iban),
          balance: account.balance,
          currency: account.currency,
          isFrozen: !!account.is_frozen,
          bankName: account.bank_name,
          bankCode: account.bank_code,
        }
      : null,
  };
}

// ------------------------------------------------------------
// POST /api/auth/register
// Creation d'un nouveau compte utilisateur + compte bancaire
// ------------------------------------------------------------
router.post(
  '/register',
  requireGuest,
  [
    body('username')
      .trim()
      .isLength({ min: 3, max: 30 })
      .withMessage('Le nom d\'utilisateur doit contenir entre 3 et 30 caracteres.')
      .matches(/^[a-zA-Z0-9_.-]+$/)
      .withMessage('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres, points, tirets et underscores.'),
    body('email')
      .trim()
      .isEmail()
      .withMessage('Adresse email invalide.')
      .normalizeEmail(),
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
    body('confirmPassword').custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('La confirmation du mot de passe ne correspond pas.');
      }
      return true;
    }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { username, email, displayName, password } = req.body;

    const existingUsername = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (existingUsername) {
      return res.status(409).json({ error: 'Ce nom d\'utilisateur est deja pris.' });
    }

    const existingEmail = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'Cette adresse email est deja utilisee.' });
    }

    const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    const insertUser = db.prepare(`
      INSERT INTO users (username, email, password_hash, display_name, role, has_tpe, is_active)
      VALUES (?, ?, ?, ?, 'user', 0, 1)
    `);

    let userId;
    try {
      const info = insertUser.run(username, email, passwordHash, displayName);
      userId = info.lastInsertRowid;
    } catch (err) {
      logger.error('Erreur lors de la creation de l\'utilisateur', { error: err });
      return res.status(500).json({ error: 'Erreur interne lors de la creation du compte.' });
    }

    try {
      createAccountForUser(userId, 0);
    } catch (err) {
      logger.error('Erreur lors de la creation du compte bancaire', { error: err, userId });
      // On supprime l'utilisateur si le compte bancaire n'a pas pu etre cree,
      // pour eviter un utilisateur "orphelin" sans compte.
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      return res.status(500).json({ error: 'Erreur interne lors de la creation du compte bancaire.' });
    }

    logActivity({
      actorUserId: userId,
      action: 'user_register',
      targetUserId: userId,
      details: { username, email },
      ipAddress: req.ip,
    });

    req.session.userId = userId;

    const userData = getUserWithAccount(userId);

    logger.info('Nouvel utilisateur inscrit', { userId, username });

    return res.status(201).json({ message: 'Compte cree avec succes.', user: userData });
  }
);

// ------------------------------------------------------------
// POST /api/auth/login
// Connexion par identifiant (username ou email) + mot de passe
// ------------------------------------------------------------
router.post(
  '/login',
  requireGuest,
  [
    body('identifier')
      .trim()
      .notEmpty()
      .withMessage('Identifiant requis.'),
    body('password')
      .notEmpty()
      .withMessage('Mot de passe requis.'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { identifier, password } = req.body;

    const user = db.prepare(`
      SELECT * FROM users WHERE username = ? OR email = ?
    `).get(identifier, identifier);

    if (!user) {
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Ce compte a ete desactive. Contactez un administrateur.' });
    }

    const passwordMatches = bcrypt.compareSync(password, user.password_hash);

    if (!passwordMatches) {
      logActivity({
        actorUserId: user.id,
        action: 'login_failed',
        targetUserId: user.id,
        details: { identifier },
        ipAddress: req.ip,
      });
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }

    req.session.userId = user.id;

    logActivity({
      actorUserId: user.id,
      action: 'login_success',
      targetUserId: user.id,
      details: null,
      ipAddress: req.ip,
    });

    const userData = getUserWithAccount(user.id);

    logger.info('Connexion utilisateur', { userId: user.id, username: user.username });

    return res.json({ message: 'Connexion reussie.', user: userData });
  }
);

// ------------------------------------------------------------
// POST /api/auth/logout
// Deconnexion : destruction de la session
// ------------------------------------------------------------
router.post('/logout', requireAuth, (req, res) => {
  const userId = req.user.id;

  logActivity({
    actorUserId: userId,
    action: 'logout',
    targetUserId: userId,
    details: null,
    ipAddress: req.ip,
  });

  req.session.destroy((err) => {
    if (err) {
      logger.error('Erreur lors de la destruction de la session', { error: err, userId });
      return res.status(500).json({ error: 'Erreur lors de la deconnexion.' });
    }
    res.clearCookie('connect.sid');
    return res.json({ message: 'Deconnexion reussie.' });
  });
});

// ------------------------------------------------------------
// GET /api/auth/me
// Retourne l'utilisateur actuellement connecte (ou 401 si non
// connecte). Utilise par le frontend au chargement des pages
// pour verifier l'etat de connexion.
// ------------------------------------------------------------
router.get('/me', requireAuth, (req, res) => {
  const userData = getUserWithAccount(req.user.id);
  return res.json({ user: userData });
});

// ------------------------------------------------------------
// POST /api/auth/change-password
// Permet a un utilisateur connecte de changer son propre
// mot de passe (necessite l'ancien mot de passe).
// ------------------------------------------------------------
router.post(
  '/change-password',
  requireAuth,
  [
    body('currentPassword').notEmpty().withMessage('Mot de passe actuel requis.'),
    body('newPassword')
      .isLength({ min: 8, max: 100 })
      .withMessage('Le nouveau mot de passe doit contenir au moins 8 caracteres.')
      .matches(/[A-Za-z]/)
      .withMessage('Le nouveau mot de passe doit contenir au moins une lettre.')
      .matches(/[0-9]/)
      .withMessage('Le nouveau mot de passe doit contenir au moins un chiffre.'),
    body('confirmNewPassword').custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error('La confirmation du nouveau mot de passe ne correspond pas.');
      }
      return true;
    }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    const matches = bcrypt.compareSync(currentPassword, fullUser.password_hash);
    if (!matches) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }

    const newHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);

    db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?
    `).run(newHash, req.user.id);

    logActivity({
      actorUserId: req.user.id,
      action: 'password_changed',
      targetUserId: req.user.id,
      details: null,
      ipAddress: req.ip,
    });

    logger.info('Mot de passe modifie', { userId: req.user.id });

    return res.json({ message: 'Mot de passe modifie avec succes.' });
  }
);

module.exports = router;
