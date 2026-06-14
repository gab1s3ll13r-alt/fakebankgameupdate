// ============================================================
// utils/logger.js
// Petit utilitaire de journalisation pour la console serveur.
// Permet d'avoir des logs uniformes (horodates, prefixes par
// niveau) sans dependance externe.
//
// Pour le journal d'activite persiste en base (consultable par
// l'administrateur), voir database/db.js -> logActivity().
// Ce module gere uniquement la sortie console (debug/exploitation).
// ============================================================

const LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
};

/**
 * Retourne un horodatage lisible au format ISO local.
 * @returns {string}
 */
function timestamp() {
  return new Date().toISOString();
}

/**
 * Formate une ligne de log avec horodatage, niveau et message.
 *
 * @param {string} level - Un des LEVELS
 * @param {string} message - Message principal
 * @param {object|null} meta - Donnees additionnelles optionnelles
 * @returns {string}
 */
function formatLine(level, message, meta) {
  let line = `[${timestamp()}] [${level}] ${message}`;
  if (meta && Object.keys(meta).length > 0) {
    try {
      line += ` | ${JSON.stringify(meta)}`;
    } catch (err) {
      line += ' | [meta non serialisable]';
    }
  }
  return line;
}

/**
 * Log de niveau informatif (operations normales).
 * @param {string} message
 * @param {object} [meta]
 */
function info(message, meta = {}) {
  console.log(formatLine(LEVELS.INFO, message, meta));
}

/**
 * Log de niveau avertissement (situation anormale mais non bloquante).
 * @param {string} message
 * @param {object} [meta]
 */
function warn(message, meta = {}) {
  console.warn(formatLine(LEVELS.WARN, message, meta));
}

/**
 * Log de niveau erreur (exception, echec d'operation).
 * Si une instance d'Error est passee dans meta.error, sa stack
 * est incluse dans la sortie pour faciliter le debug.
 *
 * @param {string} message
 * @param {object} [meta]
 */
function error(message, meta = {}) {
  const { error: err, ...rest } = meta;
  console.error(formatLine(LEVELS.ERROR, message, rest));
  if (err instanceof Error) {
    console.error(err.stack);
  } else if (err) {
    console.error(err);
  }
}

/**
 * Log de niveau debug, actif uniquement si NODE_ENV !== 'production'.
 * @param {string} message
 * @param {object} [meta]
 */
function debug(message, meta = {}) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  console.log(formatLine(LEVELS.DEBUG, message, meta));
}

/**
 * Middleware Express simple loggant chaque requete entrante
 * (methode, chemin, IP) et le code de statut de la reponse.
 *
 * @returns {import('express').RequestHandler}
 */
function requestLogger() {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      info(`${req.method} ${req.originalUrl}`, {
        status: res.statusCode,
        durationMs: duration,
        ip,
      });
    });

    next();
  };
}

module.exports = {
  info,
  warn,
  error,
  debug,
  requestLogger,
};
