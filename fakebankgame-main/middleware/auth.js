// ============================================================
// middleware/auth.js
// Middlewares de verification d'authentification (session).
//
// La session stocke uniquement l'ID utilisateur (req.session.userId).
// Ces middlewares chargent l'utilisateur correspondant depuis la
// base et le placent sur req.user pour le reste de la requete.
// ============================================================

const { db } = require('../database/db');
const logger = require('../utils/logger');

/**
 * Recupere un utilisateur complet (sans le hash de mot de passe)
 * a partir de son ID.
 *
 * @param {number} userId
 * @returns {object|undefined}
 */
function getUserById(userId) {
  return db.prepare(`
    SELECT id, username, email, display_name, role, has_tpe, tpe_label,
           is_active, created_at, updated_at
    FROM users
    WHERE id = ?
  `).get(userId);
}

/**
 * Middleware: exige qu'un utilisateur soit connecte.
 * Si la session contient un userId valide et correspondant a un
 * compte actif, place l'utilisateur sur req.user et continue.
 * Sinon, renvoie une erreur 401 (JSON) car cette application est
 * une API consommee par le frontend via fetch.
 *
 * @returns {import('express').RequestHandler}
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  const user = getUserById(req.session.userId);

  if (!user) {
    // L'utilisateur a ete supprime mais la session existe encore
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session invalide. Veuillez vous reconnecter.' });
  }

  if (!user.is_active) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'Ce compte a ete desactive.' });
  }

  req.user = user;
  next();
}

/**
 * Middleware: charge l'utilisateur si une session existe, mais
 * n'echoue pas si aucune session n'est presente. Utile pour des
 * routes publiques qui adaptent leur reponse selon l'etat de
 * connexion (ex: page d'accueil).
 *
 * @returns {import('express').RequestHandler}
 */
function attachUserIfPresent(req, res, next) {
  if (req.session && req.session.userId) {
    const user = getUserById(req.session.userId);
    if (user && user.is_active) {
      req.user = user;
    } else if (user && !user.is_active) {
      req.session.destroy(() => {});
    } else {
      req.session.destroy(() => {});
    }
  }
  next();
}

/**
 * Middleware: redirige (401 JSON) si l'utilisateur est DEJA
 * connecte, pour les routes de connexion/inscription qui ne
 * doivent pas etre accessibles a un utilisateur deja authentifie.
 *
 * @returns {import('express').RequestHandler}
 */
function requireGuest(req, res, next) {
  if (req.session && req.session.userId) {
    const user = getUserById(req.session.userId);
    if (user && user.is_active) {
      return res.status(409).json({ error: 'Vous etes deja connecte.' });
    }
  }
  next();
}

/**
 * Helper non-middleware: recharge l'utilisateur courant depuis la
 * base et met a jour req.user. Utile apres une modification de
 * son propre profil (ex: l'admin modifie son propre role).
 *
 * @param {import('express').Request} req
 */
function refreshCurrentUser(req) {
  if (req.session && req.session.userId) {
    const user = getUserById(req.session.userId);
    if (user) {
      req.user = user;
    }
  }
}

module.exports = {
  getUserById,
  requireAuth,
  attachUserIfPresent,
  requireGuest,
  refreshCurrentUser,
};
