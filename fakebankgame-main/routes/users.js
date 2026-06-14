// ============================================================
// routes/users.js
// Routes liees a la recherche d'utilisateurs (pour virements,
// paiements TPE, etc.).
//
// Ces routes ne renvoient JAMAIS d'informations sensibles
// (mot de passe, solde, email complet d'un tiers) : uniquement
// ce qui est necessaire pour identifier un destinataire.
// ============================================================

const express = require('express');

const { db } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { maskIban, cleanIban, isValidFictiveIban } = require('../utils/iban');

const router = express.Router();

// ------------------------------------------------------------
// GET /api/users/search?q=...
// Recherche des utilisateurs par nom d'utilisateur, nom affiche
// ou IBAN (recherche partielle, insensible a la casse).
//
// Retourne au maximum 10 resultats, en excluant l'utilisateur
// connecte lui-meme (on ne se "recherche" pas pour s'envoyer
// de l'argent a soi-meme).
//
// Champs retournes : id, username, displayName, ibanMasked,
// hasTpe, tpeLabel.
// Le solde et l'IBAN complet d'un tiers ne sont JAMAIS exposes
// via cette route.
// ------------------------------------------------------------
router.get('/search', requireAuth, (req, res) => {
  const rawQuery = (req.query.q || '').trim();

  if (rawQuery.length < 2) {
    return res.status(400).json({ error: 'La recherche doit contenir au moins 2 caracteres.' });
  }

  if (rawQuery.length > 50) {
    return res.status(400).json({ error: 'La recherche est trop longue (50 caracteres maximum).' });
  }

  const likeQuery = `%${rawQuery.toLowerCase()}%`;

  // Si la recherche ressemble a un IBAN (commence par FRP0 par
  // exemple), on tente aussi une correspondance directe sur l'IBAN.
  const cleanedIbanQuery = cleanIban(rawQuery);
  const looksLikeIban = /^[A-Z0-9]+$/.test(cleanedIbanQuery) && cleanedIbanQuery.length >= 4;

  let results;

  if (looksLikeIban) {
    results = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.has_tpe, u.tpe_label, a.iban
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      WHERE u.id != ?
        AND u.is_active = 1
        AND (
          LOWER(u.username) LIKE ?
          OR LOWER(u.display_name) LIKE ?
          OR a.iban LIKE ?
        )
      ORDER BY u.username ASC
      LIMIT 10
    `).all(req.user.id, likeQuery, likeQuery, `%${cleanedIbanQuery}%`);
  } else {
    results = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.has_tpe, u.tpe_label, a.iban
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      WHERE u.id != ?
        AND u.is_active = 1
        AND (
          LOWER(u.username) LIKE ?
          OR LOWER(u.display_name) LIKE ?
        )
      ORDER BY u.username ASC
      LIMIT 10
    `).all(req.user.id, likeQuery, likeQuery);
  }

  return res.json({
    results: results.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      ibanMasked: maskIban(u.iban),
      hasTpe: !!u.has_tpe,
      tpeLabel: u.tpe_label,
    })),
  });
});

// ------------------------------------------------------------
// GET /api/users/lookup?iban=...
// Recherche un utilisateur unique par IBAN exact (utilise par
// le formulaire de virement quand on saisit/scanne un IBAN
// complet, ou par le TPE pour identifier un payeur via QR).
//
// Retourne 404 si aucun compte ne correspond, ou si l'IBAN
// correspond a l'utilisateur connecte lui-meme (on ne peut pas
// se faire un virement a soi-meme).
// ------------------------------------------------------------
router.get('/lookup', requireAuth, (req, res) => {
  const rawIban = (req.query.iban || '').trim();

  if (!rawIban) {
    return res.status(400).json({ error: 'Parametre "iban" requis.' });
  }

  const cleaned = cleanIban(rawIban);

  if (!isValidFictiveIban(cleaned)) {
    return res.status(400).json({ error: 'Format d\'IBAN invalide.' });
  }

  const result = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.has_tpe, u.tpe_label, u.is_active, a.iban
    FROM users u
    JOIN accounts a ON a.user_id = u.id
    WHERE a.iban = ?
  `).get(cleaned);

  if (!result || !result.is_active) {
    return res.status(404).json({ error: 'Aucun compte ne correspond a cet IBAN.' });
  }

  if (result.id === req.user.id) {
    return res.status(400).json({ error: 'Vous ne pouvez pas effectuer un virement vers votre propre compte.' });
  }

  return res.json({
    user: {
      id: result.id,
      username: result.username,
      displayName: result.display_name,
      ibanMasked: maskIban(result.iban),
      hasTpe: !!result.has_tpe,
      tpeLabel: result.tpe_label,
    },
  });
});

module.exports = router;
