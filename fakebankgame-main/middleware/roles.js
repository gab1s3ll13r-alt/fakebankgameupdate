// ============================================================
// middleware/roles.js
// Middlewares de verification des roles et permissions.
//
// S'appuient sur req.user, place par middleware/auth.js
// (requireAuth doit etre appele avant ces middlewares).
//
// Roles possibles (table users.role): 'user' | 'employee' | 'admin'
// Acces TPE: flag independant users.has_tpe (0/1)
// ============================================================

/**
 * Middleware factory: exige que req.user.role soit l'un des
 * roles fournis.
 *
 * @param {...string} allowedRoles - Roles autorises ('user', 'employee', 'admin')
 * @returns {import('express').RequestHandler}
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentification requise.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Acces refuse : permissions insuffisantes pour cette operation.',
      });
    }

    next();
  };
}

/**
 * Middleware: reserve aux administrateurs uniquement.
 * @returns {import('express').RequestHandler}
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acces reserve aux administrateurs.' });
  }

  next();
}

/**
 * Middleware: reserve aux employes de banque ET aux administrateurs
 * (un admin peut toujours faire ce qu'un employe peut faire).
 * @returns {import('express').RequestHandler}
 */
function requireEmployeeOrAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  if (req.user.role !== 'employee' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acces reserve aux employes de banque et administrateurs.' });
  }

  next();
}

/**
 * Middleware: exige que l'utilisateur possede un acces TPE
 * (users.has_tpe = 1), independamment de son role.
 * Un admin a toujours acces (controle total de la plateforme).
 * @returns {import('express').RequestHandler}
 */
function requireTpeAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  if (req.user.role === 'admin') {
    return next();
  }

  if (!req.user.has_tpe) {
    return res.status(403).json({ error: 'Acces reserve aux utilisateurs disposant d\'un TPE.' });
  }

  next();
}

/**
 * Helper non-middleware: indique si un utilisateur peut consulter
 * un compte/transaction donne. Un admin ou un employe peut tout
 * consulter ; un utilisateur standard ne peut consulter que ses
 * propres donnees.
 *
 * @param {object} user - req.user
 * @param {number} targetUserId - ID de l'utilisateur cible
 * @returns {boolean}
 */
function canViewUserData(user, targetUserId) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'employee') return true;
  return user.id === targetUserId;
}

/**
 * Helper non-middleware: indique si un utilisateur peut effectuer
 * des operations bancaires manuelles (credit/debit) sur un compte.
 * Reserve aux employes et administrateurs.
 *
 * @param {object} user - req.user
 * @returns {boolean}
 */
function canPerformManualOperations(user) {
  if (!user) return false;
  return user.role === 'employee' || user.role === 'admin';
}

/**
 * Helper non-middleware: indique si un utilisateur peut modifier
 * les parametres systeme / roles / TPE des autres utilisateurs.
 * Reserve aux administrateurs uniquement.
 *
 * @param {object} user - req.user
 * @returns {boolean}
 */
function canManageSystem(user) {
  if (!user) return false;
  return user.role === 'admin';
}

module.exports = {
  requireRole,
  requireAdmin,
  requireEmployeeOrAdmin,
  requireTpeAccess,
  canViewUserData,
  canManageSystem,
  canPerformManualOperations,
};
