// ============================================================
// server.js
// Point d'entree de l'application Banque RP.
// ============================================================

const path    = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
require('dotenv').config();

const { db }  = require('./database/db');
const logger  = require('./utils/logger');

const authRoutes         = require('./routes/auth');
const accountRoutes      = require('./routes/account');
const transactionsRoutes = require('./routes/transactions');
const usersRoutes        = require('./routes/users');
const tpeRoutes          = require('./routes/tpe');
const adminRoutes        = require('./routes/admin');
const employeeRoutes     = require('./routes/employee');
const requestsRoutes     = require('./routes/requests');
const setupRoutes        = require('./routes/setup');

const app = express();

const PORT       = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV   = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

// Pinggy / proxy inverse
app.set('trust proxy', 1);

// ------------------------------------------------------------
// Middlewares
// ------------------------------------------------------------
app.use(logger.requestLogger());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ------------------------------------------------------------
// Sessions
// ------------------------------------------------------------
const sessionDbDir  = path.dirname(
  path.resolve(__dirname, process.env.SESSION_DB_PATH || './database/sessions.db')
);
const sessionDbFile = path.basename(
  process.env.SESSION_DB_PATH || './database/sessions.db'
);

app.use(
  session({
    store: new SQLiteStore({
      db:    sessionDbFile,
      dir:   sessionDbDir,
      table: 'sessions',
    }),
    secret:            process.env.SESSION_SECRET || 'change-this-secret-key',
    resave:            false,
    saveUninitialized: false,
    rolling:           true,
    cookie: {
      httpOnly: true,
      secure:   isProduction,
      sameSite: 'lax',
      maxAge:   7 * 24 * 60 * 60 * 1000,
    },
  })
);

// ------------------------------------------------------------
// Routes API
// ------------------------------------------------------------
app.use('/api/auth',         authRoutes);
app.use('/api/account',      accountRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/users',        usersRoutes);
app.use('/api/tpe',          tpeRoutes);
app.use('/api/admin',        adminRoutes);
app.use('/api/employee',     employeeRoutes);
app.use('/api/requests',     requestsRoutes);
app.use('/api/setup',        setupRoutes);

// ------------------------------------------------------------
// Fichiers statiques
// ------------------------------------------------------------
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ------------------------------------------------------------
// SPA fallback
// ------------------------------------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// ------------------------------------------------------------
// 404 API
// ------------------------------------------------------------
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Route API introuvable.' });
});

// ------------------------------------------------------------
// Erreur globale
// ------------------------------------------------------------
app.use((err, req, res, next) => {
  logger.error('Erreur serveur', { error: err, path: req.path });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erreur interne serveur.' });
});

// ------------------------------------------------------------
// Demarrage
// ------------------------------------------------------------
app.listen(PORT, () => {
  logger.info('Serveur demarre', { port: PORT, env: NODE_ENV });
  console.log('============================================================');
  console.log('  Banque RP - serveur demarre');
  console.log(`  Local   : http://localhost:${PORT}`);
  console.log(`  Mode    : ${NODE_ENV}`);
  console.log('============================================================');
  console.log('  Pour accès multi-joueurs via Pinggy, voir INSTALL.md');
  console.log('============================================================');
});

// ------------------------------------------------------------
// Arret propre
// ------------------------------------------------------------
function shutdown(signal) {
  logger.info(`Arret ${signal}`);
  try { db.close(); } catch (e) {}
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));