import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// Point the app at a throwaway database before any app module is imported.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesa-transfer-'));
const dbPath = path.join(dir, 'wallet.db');
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const { db, migrate } = await import('../src/db/index.js');
const { createUser } = await import('../src/lib/auth.js');
const { createTransfer, listTransfers } = await import('../src/services/transfers.js');

migrate();

function addAccount(userId, name, openingCents) {
  const info = db
    .prepare('INSERT INTO accounts (user_id, name, type, opening_balance_cents) VALUES (?, ?, ?, ?)')
    .run(userId, name, 'bank', openingCents);
  return Number(info.lastInsertRowid);
}

function balance(accountId) {
  const row = db
    .prepare(
      `SELECT a.opening_balance_cents
         + COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END), 0) AS balance_cents
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.id = ?
       GROUP BY a.id`,
    )
    .get(accountId);
  return row.balance_cents;
}

function transferCount(userId) {
  return db.prepare('SELECT COUNT(*) AS count FROM transfers WHERE user_id = ?').get(userId).count;
}

test('a transfer updates both balances and is saved once', () => {
  const user = createUser({ name: 'Amina', email: 'amina@example.com', password: 'password123' });
  const cash = addAccount(user.id, 'Cash', 10_000);
  const savings = addAccount(user.id, 'Savings', 2_000);

  const result = createTransfer(user.id, {
    from_account_id: cash,
    to_account_id: savings,
    amount_cents: 2_500,
    reference: 'ref-success-0001',
    note: 'Weekly savings',
  });

  assert.equal(result.duplicate, false);
  assert.equal(balance(cash), 7_500);
  assert.equal(balance(savings), 4_500);
  assert.equal(listTransfers(user.id).length, 1);
  assert.equal(listTransfers(user.id)[0].note, 'Weekly savings');
});

test('the same reference does not move the money twice', () => {
  const user = createUser({ name: 'Brian', email: 'brian@example.com', password: 'password123' });
  const cash = addAccount(user.id, 'Cash', 8_000);
  const bank = addAccount(user.id, 'Bank', 0);
  const input = {
    from_account_id: cash,
    to_account_id: bank,
    amount_cents: 1_000,
    reference: 'ref-duplicate-01',
    note: '',
  };

  const first = createTransfer(user.id, input);
  const second = createTransfer(user.id, input);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.transfer.id, first.transfer.id);
  assert.equal(balance(cash), 7_000);
  assert.equal(balance(bank), 1_000);
  assert.equal(transferCount(user.id), 1);
});

test('insufficient funds leaves both accounts unchanged', () => {
  const user = createUser({ name: 'Chantal', email: 'chantal@example.com', password: 'password123' });
  const cash = addAccount(user.id, 'Cash', 500);
  const bank = addAccount(user.id, 'Bank', 100);

  assert.throws(
    () =>
      createTransfer(user.id, {
        from_account_id: cash,
        to_account_id: bank,
        amount_cents: 501,
        reference: 'ref-insufficient1',
      }),
    (error) => error.status === 422 && /not enough money/i.test(error.message),
  );

  assert.equal(balance(cash), 500);
  assert.equal(balance(bank), 100);
  assert.equal(transferCount(user.id), 0);
});

test('same account, another user, and a bad amount are rejected', () => {
  const owner = createUser({ name: 'David', email: 'david@example.com', password: 'password123' });
  const other = createUser({ name: 'Eve', email: 'eve@example.com', password: 'password123' });
  const cash = addAccount(owner.id, 'Cash', 5_000);
  const foreign = addAccount(other.id, 'Eve Cash', 9_000);

  assert.throws(
    () =>
      createTransfer(owner.id, {
        from_account_id: cash,
        to_account_id: cash,
        amount_cents: 100,
        reference: 'ref-same-account1',
      }),
    (error) => error.status === 422,
  );

  assert.throws(
    () =>
      createTransfer(owner.id, {
        from_account_id: cash,
        to_account_id: foreign,
        amount_cents: 100,
        reference: 'ref-not-yours-001',
      }),
    (error) => error.status === 422,
  );

  assert.throws(
    () =>
      createTransfer(owner.id, {
        from_account_id: cash,
        to_account_id: addAccount(owner.id, 'Bank', 0),
        amount_cents: 0,
        reference: 'ref-zero-amount1',
      }),
    (error) => error.status === 422,
  );

  assert.equal(balance(cash), 5_000);
  assert.equal(balance(foreign), 9_000);
});  

test('a failure after the debit rolls every change back', () => {
  const user = createUser({ name: 'Fiona', email: 'fiona@example.com', password: 'password123' });
  const cash = addAccount(user.id, 'Cash', 4_000);
  const bank = addAccount(user.id, 'Bank', 1_000);

  assert.throws(() =>
    createTransfer(
      user.id,
      {
        from_account_id: cash,
        to_account_id: bank,
        amount_cents: 1_500,
        reference: 'ref-rollback-0001',
      },
      { failBeforeCredit: true },
    ),
  );

  assert.equal(balance(cash), 4_000);
  assert.equal(balance(bank), 1_000);
  assert.equal(transferCount(user.id), 0);
  const ledger = db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?').get(user.id);
  assert.equal(ledger.count, 0);
});

test('two transfers racing for the same balance cannot overdraw', async () => {
  const user = createUser({ name: 'Grace', email: 'grace@example.com', password: 'password123' });
  const cash = addAccount(user.id, 'Cash', 3_000);
  const bank = addAccount(user.id, 'Bank', 0);
  const savings = addAccount(user.id, 'Savings', 0);

  const workerFile = fileURLToPath(new URL('./transfer-worker.js', import.meta.url));
  const run = (reference, toAccountId) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerFile, {
        workerData: {
          dbPath,
          userId: user.id,
          input: {
            from_account_id: cash,
            to_account_id: toAccountId,
            amount_cents: 3_000,
            reference,
            note: '',
          },
        },
      });
      worker.once('message', resolve);
      worker.once('error', reject);
    });

  const [first, second] = await Promise.all([
    run('ref-race-aaaaaa', bank),
    run('ref-race-bbbbbb', savings),
  ]);

  const results = [first, second];
  const saved = results.filter((result) => result.ok);
  const rejected = results.filter((result) => !result.ok);

  assert.equal(saved.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].message, /not enough money/i);
  assert.equal(balance(cash), 0);
  assert.equal(balance(bank) + balance(savings), 3_000);
  assert.equal(transferCount(user.id), 1);
});

test.after(() => {
  db.close();
});
