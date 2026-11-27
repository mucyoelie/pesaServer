import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path of the SQLite file. Overridable so a deployment platform can point
 * the database at a mounted persistent disk.
 */
export const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', '..', 'data', 'wallet.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// WAL keeps reads fast while a write is in flight, and foreign_keys makes the
// ON DELETE rules in the schema actually fire (SQLite has them off by default).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Wait briefly if another request is already writing, instead of failing at once.
db.pragma('busy_timeout = 5000');

const OWNED_TABLES = ['accounts', 'categories', 'transactions', 'budgets', 'transfers'];

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

/**
 * Older databases were created before accounts had owners. SQLite cannot add a
 * NOT NULL column without a default, so legacy tables receive a nullable user_id;
 * every query filters on the signed-in user and boot hands those rows to the demo
 * account (see adoptOrphanRows).
 */
function ensureOwnershipColumns() {
  for (const table of OWNED_TABLES) {
    if (!columnNames(table).includes('user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table} (user_id)`);
  }

  // Uniqueness is per user: two people may both have "Groceries" or a July budget.
  db.exec('DROP INDEX IF EXISTS idx_categories_unique');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique
       ON categories (user_id, kind, lower(name), ifnull(parent_id, 0))`,
  );
  db.exec('DROP INDEX IF EXISTS idx_budgets_unique');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_unique
       ON budgets (user_id, period, ifnull(category_id, 0))`,
  );
}

/** Older databases were created before transfers were marked on the ledger. */
function ensureTransferColumn() {
  if (!columnNames('transactions').includes('is_transfer')) {
    db.exec('ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0');
  }
}

/** Apply the schema and ownership upgrades. Safe to call on every boot. */
export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  ensureOwnershipColumns();
  ensureTransferColumn();
}

/** Give rows created before authentication existed to `userId`. */
export function adoptOrphanRows(userId) {
  const update = db.prepare('UPDATE accounts SET user_id = ? WHERE user_id IS NULL');
  update.run(userId);
  db.prepare('UPDATE categories SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE transactions SET user_id = ? WHERE user_id IS NULL').run(userId);
  db.prepare('UPDATE budgets SET user_id = ? WHERE user_id IS NULL').run(userId);
}

/** Run a function inside a single SQLite transaction. */
export function transaction(fn) {
  return db.transaction(fn)();
}

/** YYYY-MM for a Date (local time), matching the budget `period` format. */
export function periodOf(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
