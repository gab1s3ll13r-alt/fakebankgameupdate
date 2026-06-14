const express = require('express');
const router = express.Router();
const { db } = require('../database/db');

router.get('/health', (req, res) => {
  try {
    const ok = db.prepare('SELECT 1 AS ok').get();

    return res.json({
      status: 'ok',
      db: ok ? 'connected' : 'error',
    });
  } catch (err) {
    return res.status(500).json({ status: 'error' });
  }
});

router.get('/info', (req, res) => {
  res.json({
    name: 'Banque RP',
    status: 'running',
  });
});

module.exports = router;