// ============================================================
// database/db.js
// Connexion SQLite + initialisation propre
// ============================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH
  ? path.resolve(__dirname, '..', process.env.DB_PATH)
  : path.resolve(__dirname, 'banque.db');

const INIT_SQL_PATH = path.resolve(__dirname, 'init.sql');

// ------------------------------------------------------------
// Base de données
// ------------------------------------------------------------
const dbDir = path.dirname(DB_PATH);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ------------------------------------------------------------
// IBAN utils
// ------------------------------------------------------------
function generateRandomDigits(length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 10);
  }
  return result;
}

function generateIban(bankCode) {
  const code = (bankCode || 'BRP0').toUpperCase().padEnd(4, '0').slice(0, 4);

  return `FRP0${code}` +
    generateRandomDigits(4) +
    generateRandomDigits(4) +
    generateRandomDigits(4) +
    generateRandomDigits(4);
}

function generateUniqueIban(bankCode) {
  const check = db.prepare('SELECT 1 FROM accounts WHERE iban = ?');

  let iban;
  do {
    iban = generateIban(bankCode);
  } while (check.get(iban));

  return iban;
}

// ------------------------------------------------------------
// INIT SQL
// ------------------------------------------------------------
function initSchema() {
  const sql = fs.readFileSync(INIT_SQL_PATH, 'utf8');
  db.exec(sql);
}

// ------------------------------------------------------------
// Banque par défaut
// ------------------------------------------------------------
function ensureDefaultBank() {
  const name = process.env.DEFAULT_BANK_NAME || 'Banque Centrale RP';
  const code = (process.env.DEFAULT_BANK_CODE || 'BRP0').toUpperCase().slice(0, 4);

  const existing = db.prepare('SELECT * FROM banks WHERE code = ?').get(code);
  if (existing) return existing;

  const insert = db.prepare('INSERT INTO banks (name, code) VALUES (?, ?)');
  const info = insert.run(name, code);

  return db.prepare('SELECT * FROM banks WHERE id = ?').get(info.lastInsertRowid);
}

// ------------------------------------------------------------
// INIT DB (SANS ADMIN AUTO)
// ------------------------------------------------------------
function initializeDatabase() {
  initSchema();
  ensureDefaultBank();
  // ❌ plus d'admin automatique
}

initializeDatabase();

// ------------------------------------------------------------
// CREATE ACCOUNT USER
// ------------------------------------------------------------
function createAccountForUser(userId, initialBalance = 0) {
  const bankCode = (process.env.DEFAULT_BANK_CODE || 'BRP0').toUpperCase().slice(0, 4);

  let bank = db.prepare('SELECT * FROM banks WHERE code = ?').get(bankCode);
  if (!bank) bank = ensureDefaultBank();

  const iban = generateUniqueIban(bank.code);

  const insert = db.prepare(`
    INSERT INTO accounts (user_id, bank_id, iban, balance, currency)
    VALUES (?, ?, ?, ?, ?)
  `);

  const info = insert.run(
    userId,
    bank.id,
    iban,
    initialBalance,
    process.env.CURRENCY_CODE || 'EUR'
  );

  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid);
}

// ------------------------------------------------------------
// BANK LIST
// ------------------------------------------------------------
function getAllBanks() {
  return db.prepare('SELECT * FROM banks ORDER BY id ASC').all();
}

// ------------------------------------------------------------
// LOG ACTIVITY
// ------------------------------------------------------------
function logActivity({
  actorUserId = null,
  action,
  targetUserId = null,
  details = null,
  ipAddress = null
}) {
  db.prepare(`
    INSERT INTO activity_logs (
      actor_user_id,
      action,
      target_user_id,
      details,
      ip_address
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    actorUserId,
    action,
    targetUserId,
    details ? JSON.stringify(details) : null,
    ipAddress
  );
}

// ------------------------------------------------------------
// EXPORTS
// ------------------------------------------------------------
module.exports = {
  db,
  generateUniqueIban,
  createAccountForUser,
  getAllBanks,
  logActivity,
};
