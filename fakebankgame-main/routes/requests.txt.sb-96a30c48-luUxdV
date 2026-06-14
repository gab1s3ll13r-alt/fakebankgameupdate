// ============================================================
// routes/requests.js
// Gestion des demandes bancaires utilisateurs
// - Création de demande (crédit, ouverture service, etc.)
// - Consultation des demandes utilisateur
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');

const { db, logActivity } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// ------------------------------------------------------------
// POST /api/requests
// Création d'une demande utilisateur
// ------------------------------------------------------------
router.post(
  '/',
  requireAuth,
  [
    body('type')
      .trim()
      .notEmpty()
      .withMessage('Type de demande requis.'),
    body('message')
      .trim()
      .isLength({ min: 5, max: 500 })
      .withMessage('Message requis (5 à 500 caractères).'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { type, message } = req.body;
    const userId = req.user.id;

    try {
      const stmt = db.prepare(`
        INSERT INTO requests (user_id, type, message, status, created_at)
        VALUES (?, ?, ?, 'pending', datetime('now'))
      `);

      const result = stmt.run(userId, type, message);

      logActivity({
        actorUserId: userId,
        action: 'request_created',
        targetUserId: userId,
        details: { type, message },
        ipAddress: req.ip,
      });

      logger.info('Nouvelle demande utilisateur', { userId, type });

      return res.status(201).json({
        message: 'Demande envoyee avec succes.',
        requestId: result.lastInsertRowid,
      });
    } catch (err) {
      logger.error('Erreur creation request', { error: err, userId });

      return res.status(500).json({
        error: 'Erreur interne lors de la creation de la demande.',
      });
    }
  }
);

// ------------------------------------------------------------
// GET /api/requests/mine
// Liste des demandes de l'utilisateur connecté
// ------------------------------------------------------------
router.get('/mine', requireAuth, (req, res) => {
  const userId = req.user.id;

  try {
    const requests = db.prepare(`
      SELECT id, type, message, status, created_at
      FROM requests
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);

    return res.json({ requests });
  } catch (err) {
    logger.error('Erreur recuperation requests', { error: err, userId });

    return res.status(500).json({
      error: 'Erreur lors de la recuperation des demandes.',
    });
  }
});

module.exports = router;
