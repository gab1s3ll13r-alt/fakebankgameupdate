// ============================================================
// utils/iban.js
// Utilitaires lies aux IBAN fictifs : formatage pour affichage,
// validation de format, masquage partiel.
//
// La generation et la garantie d'unicite des IBAN se trouvent
// dans database/db.js (generateUniqueIban), car elles necessitent
// un acces direct a la base pour verifier les doublons.
// Ce module ne contient que des fonctions pures, sans dependance
// a la base de donnees.
// ============================================================

/**
 * Formate un IBAN fictif stocke sans espaces (ex: "FRP0BRP012345678901234567")
 * en groupes de 4 caracteres pour l'affichage
 * (ex: "FRP0 BRP0 1234 5678 9012 3456 7").
 *
 * @param {string} iban - IBAN brut tel que stocke en base
 * @returns {string} IBAN formate avec espaces
 */
function formatIban(iban) {
  if (!iban || typeof iban !== 'string') {
    return '';
  }

  const cleaned = iban.replace(/\s+/g, '').toUpperCase();
  const groups = [];

  for (let i = 0; i < cleaned.length; i += 4) {
    groups.push(cleaned.slice(i, i + 4));
  }

  return groups.join(' ');
}

/**
 * Retire les espaces d'un IBAN saisi par un utilisateur, pour
 * obtenir le format brut tel que stocke en base.
 *
 * @param {string} iban - IBAN saisi (avec ou sans espaces)
 * @returns {string} IBAN nettoye, en majuscules, sans espaces
 */
function cleanIban(iban) {
  if (!iban || typeof iban !== 'string') {
    return '';
  }
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * Verifie qu'une chaine respecte le format des IBAN fictifs
 * generes par cette application : prefixe "FRP0", suivi de
 * 4 caracteres alphanumeriques (code banque) puis 16 chiffres.
 * Total: 24 caracteres.
 *
 * Cette fonction ne valide PAS un IBAN reel (cle de controle ISO),
 * uniquement le format interne propre a la simulation.
 *
 * @param {string} iban - IBAN a verifier (avec ou sans espaces)
 * @returns {boolean} true si le format est valide
 */
function isValidFictiveIban(iban) {
  const cleaned = cleanIban(iban);
  const pattern = /^FRP0[A-Z0-9]{4}\d{16}$/;
  return pattern.test(cleaned);
}

/**
 * Masque partiellement un IBAN pour un affichage discret
 * (ex: dans des listes ou notifications), en ne montrant que
 * le prefixe et les 4 derniers chiffres.
 *
 * Exemple: "FRP0BRP012345678901234567"
 *       -> "FRP0 BRP0 •••• •••• •••• 4567"
 *
 * @param {string} iban - IBAN brut tel que stocke en base
 * @returns {string} IBAN partiellement masque
 */
function maskIban(iban) {
  const cleaned = cleanIban(iban);

  if (cleaned.length < 8) {
    return formatIban(cleaned);
  }

  const prefix = cleaned.slice(0, 8); // FRP0 + code banque
  const suffix = cleaned.slice(-4);
  const maskedLength = cleaned.length - prefix.length - suffix.length;

  let masked = prefix;
  for (let i = 0; i < maskedLength; i += 4) {
    const remaining = maskedLength - i;
    masked += remaining >= 4 ? '••••' : '•'.repeat(remaining);
  }
  masked += suffix;

  return formatIban(masked);
}

module.exports = {
  formatIban,
  cleanIban,
  isValidFictiveIban,
  maskIban,
};
