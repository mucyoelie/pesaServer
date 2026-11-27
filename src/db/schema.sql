-- Pesa Wallet schema.
-- Money is always stored as INTEGER cents so totals never suffer from float drift.
-- Dates are stored as ISO calendar dates (YYYY-MM-DD) which keeps range queries simple
-- and timezone independent.
-- Every data row belongs to a user: deleting a user deletes their wallet with it.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

-- Sessions hold a hash of an opaque cookie token, never the token itself.
-- expires_at is a unix epoch in milliseconds so expiry checks are timezone free.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT    NOT NULL,
  type                  TEXT    NOT NULL CHECK (type IN ('bank', 'mobile_money', 'cash', 'savings', 'other')),
  institution           TEXT,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  color                 TEXT    NOT NULL DEFAULT '#6366f1',
  is_archived           INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Categories are a two level tree: a row with parent_id NULL is a top level
-- category, otherwise it is a subcategory of that parent. `kind` tells whether the
-- category classifies money coming in or going out.
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('income', 'expense')),
  parent_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  color      TEXT    NOT NULL DEFAULT '#64748b',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id)   ON DELETE CASCADE,
  category_id  INTEGER          REFERENCES categories(id) ON DELETE SET NULL,
  type         TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description  TEXT    NOT NULL DEFAULT '',
  date         TEXT    NOT NULL,
  -- 1 when this row is one side of a transfer. It still changes the account
  -- balance, but reports skip it so moving money is not counted as income or spending.
  is_transfer  INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions (date);
CREATE INDEX IF NOT EXISTS idx_transactions_account  ON transactions (account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category_id);

-- A budget is scoped to a month ("YYYY-MM"). category_id NULL means the budget
-- covers every expense of that month.
CREATE TABLE IF NOT EXISTS budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id  INTEGER REFERENCES categories(id) ON DELETE CASCADE,
  period       TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per money move between two accounts owned by the same user.
-- `reference` is the idempotency key: the same key cannot be saved twice.
CREATE TABLE IF NOT EXISTS transfers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  reference       TEXT    NOT NULL,
  note            TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (from_account_id != to_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_reference ON transfers (user_id, reference);
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers (user_id, id);

-- Per user indexes and per user unique constraints are created by migrate() in
-- db/index.js, which also upgrades databases created before authentication existed.
