// ============================================================
// routes/requests.js
// Gestion des demandes bancaires soumises par les utilisateurs.
// Utilise la table bank_requests (schema init.sql).
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');

const { db, logActivity } = require('../database/db');
const { requireAuth }     = require('../middleware/auth');
const logger              = require('../utils/logger');

const router = express.Router();

// Types valides en base (CHECK constraint de bank_requests)
const VALID_TYPES = ['credit_request', 'tpe_request', 'support', 'other'];

// ------------------------------------------------------------
// POST /api/requests
// Creation d'une demande utilisateur
// ------------------------------------------------------------
router.post(
  '/',
  requireAuth,
  [
    body('type')
      .trim()
      .isIn(VALID_TYPES)
      .withMessage(`Type invalide. Valeurs acceptees : ${VALID_TYPES.join(', ')}.`),
    body('subject')
      .trim()
      .isLength({ min: 3, max: 150 })
      .withMessage('Sujet requis (3 a 150 caracteres).'),
    body('message')
      .trim()
      .isLength({ min: 5, max: 1000 })
      .withMessage('Message requis (5 a 1000 caracteres).'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Validation echouee.', details: errors.array() });
    }

    const { type, subject, message } = req.body;
    const userId = req.user.id;

    try {
      const stmt = db.prepare(`
        INSERT INTO bank_requests (user_id, type, subject, message, status)
        VALUES (?, ?, ?, ?, 'open')
      `);

      const result = stmt.run(userId, type, subject, message);

      logActivity({
        actorUserId:  userId,
        action:       'request_created',
        targetUserId: userId,
        details:      { type, subject },
        ipAddress:    req.ip,
      });

      logger.info('Nouvelle demande bancaire', { userId, type, subject });

      return res.status(201).json({
        message:   'Demande envoyee avec succes.',
        requestId: result.lastInsertRowid,
      });
    } catch (err) {
      logger.error('Erreur creation bank_request', { error: err, userId });
      return res.status(500).json({
        error: 'Erreur interne lors de la creation de la demande.',
      });
    }
  }
);

// ------------------------------------------------------------
// GET /api/requests/mine
// Liste des demandes de l'utilisateur connecte
// ------------------------------------------------------------
router.get('/mine', requireAuth, (req, res) => {
  const userId = req.user.id;

  try {
    const requests = db.prepare(`
      SELECT id, type, subject, message, status, response, created_at, updated_at
      FROM bank_requests
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(userId);

    return res.json({ requests });
  } catch (err) {
    logger.error('Erreur recuperation bank_requests', { error: err, userId });
    return res.status(500).json({
      error: 'Erreur lors de la recuperation des demandes.',
    });
  }
});