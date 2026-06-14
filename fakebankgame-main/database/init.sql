-- ============================================================
-- Schema complet - Banque RP
-- Base de donnees SQLite pour simulation bancaire (jeu de role)
-- Toutes les donnees sont fictives, aucun lien avec une vraie banque
-- ============================================================

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- Table: banks
-- Liste des banques fictives disponibles dans le systeme
-- Permet d'ajouter ulterieurement plusieurs banques
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------
-- Table: users
-- Comptes utilisateurs (joueurs, employes, admin)
-- role: 'user' | 'employee' | 'admin'
-- has_tpe: 0 ou 1, independant du role (attribue par l'admin)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'employee', 'admin')),
    has_tpe INTEGER NOT NULL DEFAULT 0 CHECK (has_tpe IN (0, 1)),
    tpe_label TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ------------------------------------------------------------
-- Table: accounts
-- Comptes bancaires fictifs (un compte par utilisateur)
-- balance stockee en centimes (INTEGER) pour eviter les erreurs
-- d'arrondi en virgule flottante
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    bank_id INTEGER NOT NULL,
    iban TEXT NOT NULL UNIQUE,
    balance INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'EUR',
    is_frozen INTEGER NOT NULL DEFAULT 0 CHECK (is_frozen IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_iban ON accounts(iban);

-- ------------------------------------------------------------
-- Table: transactions
-- Historique de toutes les operations (virements, depots,
-- retraits, paiements TPE, operations manuelles employes)
--
-- type:
--   'transfer'      -> virement utilisateur a utilisateur
--   'tpe_payment'    -> paiement via TPE
--   'manual_credit'  -> credit manuel par employe/admin
--   'manual_debit'   -> debit manuel par employe/admin
--   'admin_adjust'   -> modification directe de solde par admin
--
-- status: 'completed' | 'failed' | 'pending'
--
-- from_account_id / to_account_id peuvent etre NULL pour les
-- operations qui n'ont qu'un seul cote (ex: ajustement admin)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('transfer', 'tpe_payment', 'manual_credit', 'manual_debit', 'admin_adjust')),
    from_account_id INTEGER,
    to_account_id INTEGER,
    amount INTEGER NOT NULL CHECK (amount > 0),
    balance_after_from INTEGER,
    balance_after_to INTEGER,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'pending')),
    performed_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (from_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (to_account_id) REFERENCES accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_uuid ON transactions(uuid);

-- ------------------------------------------------------------
-- Table: tpe_payments
-- Details specifiques aux paiements TPE (lien vers transaction)
-- Permet de retrouver facilement l'historique TPE d'un commercant
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tpe_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    merchant_user_id INTEGER NOT NULL,
    payer_user_id INTEGER,
    label TEXT,
    qr_code_uuid TEXT NOT NULL UNIQUE,
    qr_status TEXT NOT NULL DEFAULT 'pending' CHECK (qr_status IN ('pending', 'paid', 'expired', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at TEXT,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
    FOREIGN KEY (merchant_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (payer_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tpe_merchant ON tpe_payments(merchant_user_id);
CREATE INDEX IF NOT EXISTS idx_tpe_qr ON tpe_payments(qr_code_uuid);
CREATE INDEX IF NOT EXISTS idx_tpe_status ON tpe_payments(qr_status);

-- ------------------------------------------------------------
-- Table: notifications
-- Notifications utilisateur (reception de virement, paiement TPE, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info', 'success', 'warning', 'error')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    related_transaction_id INTEGER,
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (related_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);

-- ------------------------------------------------------------
-- Table: activity_logs
-- Journal d'activite global (consultable par l'administrateur)
-- Trace les actions sensibles : connexions, modifications de role,
-- ajustements de solde, gel de compte, etc.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    action TEXT NOT NULL,
    target_user_id INTEGER,
    details TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_logs(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);

-- ------------------------------------------------------------
-- Table: bank_requests
-- Demandes liees a la banque, gerees par les employes
-- (ex: demande de credit, signalement, demande de TPE, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('credit_request', 'tpe_request', 'support', 'other')),
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'rejected')),
    handled_by INTEGER,
    response TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_user ON bank_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON bank_requests(status);
