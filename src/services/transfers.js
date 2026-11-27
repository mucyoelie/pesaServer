import { db } from '../db/index.js';
import { ApiError } from '../lib/errors.js';

const TRANSFER_SELECT = `
  SELECT t.id, t.from_account_id, t.to_account_id, t.amount_cents,
         t.reference, t.note, t.created_at,
         src.name AS from_account_name,
         dst.name AS to_account_name
  FROM transfers t
  JOIN accounts src ON src.id = t.from_account_id
  JOIN accounts dst ON dst.id = t.to_account_id
`;

function today() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** One account plus the balance the rest of the app already uses. */
function findOwnedAccount(userId, accountId) {
  return db
    .prepare(
      `SELECT a.id, a.name, a.is_archived,
              a.opening_balance_cents
                + COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END), 0)
                AS balance_cents
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.id = @accountId AND a.user_id = @userId
       GROUP BY a.id`,
    )
    .get({ accountId, userId });
}

function findByReference(userId, reference) {
  return db
    .prepare(`${TRANSFER_SELECT} WHERE t.user_id = @userId AND t.reference = @reference`)
    .get({ userId, reference });
}

export function listTransfers(userId) {
  return db
    .prepare(`${TRANSFER_SELECT} WHERE t.user_id = @userId ORDER BY t.id DESC LIMIT 50`)
    .all({ userId });
}

function reject(field, message) {
  throw new ApiError(422, message, [{ field, message }]);
}

/**
 * Move money from one of the user's accounts to another.
 *
 * Steps (all inside one database transaction):
 * 1. If this reference was already saved, return that transfer and stop.
 * 2. Load both accounts and reject accounts the user does not own.
 * 3. Reject a transfer to the same account, a bad amount, or an archived account.
 * 4. Reject the transfer when the source balance is too small.
 * 5. Write the outgoing transaction, then the incoming one.
 * 6. Save the transfer row. The unique reference blocks a second insert.
 *
 * If any step throws, SQLite rolls the whole transaction back.
 * `options.failBeforeCredit` is only for the rollback test.
 */
export function createTransfer(userId, input, options = {}) {
  const run = db.transaction(() => {
    const reference = String(input.reference ?? '').trim();
    const amount = input.amount_cents;

    // Step 1
    const alreadySaved = findByReference(userId, reference);
    if (alreadySaved) return { transfer: alreadySaved, duplicate: true };

    // Step 2
    const source = findOwnedAccount(userId, input.from_account_id);
    const destination = findOwnedAccount(userId, input.to_account_id);
    if (!source) reject('from_account_id', 'That account does not exist');
    if (!destination) reject('to_account_id', 'That account does not exist');

    // Step 3
    if (source.id === destination.id) reject('to_account_id', 'Choose two different accounts');
    if (!Number.isInteger(amount) || amount <= 0) reject('amount_cents', 'Amount must be greater than zero');
    if (source.is_archived || destination.is_archived) {
      reject('from_account_id', 'Archived accounts cannot send or receive transfers');
    }

    // Step 4 — read the balance inside the transaction so two requests cannot both pass.
    if (source.balance_cents < amount) reject('amount_cents', 'Not enough money in the source account');

    const note = String(input.note ?? '').trim();
    const date = today();
    const outgoing = `Transfer to ${destination.name}${note ? ` — ${note}` : ''}`.slice(0, 160);
    const incoming = `Transfer from ${source.name}${note ? ` — ${note}` : ''}`.slice(0, 160);

    // Step 5
    db.prepare(
      `INSERT INTO transactions (user_id, account_id, type, amount_cents, description, date, is_transfer)
       VALUES (@userId, @accountId, 'expense', @amount, @description, @date, 1)`,
    ).run({ userId, accountId: source.id, amount, description: outgoing, date });

    if (options.failBeforeCredit) {
      throw new Error('Simulated failure before the destination account was credited');
    }

    db.prepare(
      `INSERT INTO transactions (user_id, account_id, type, amount_cents, description, date, is_transfer)
       VALUES (@userId, @accountId, 'income', @amount, @description, @date, 1)`,
    ).run({ userId, accountId: destination.id, amount, description: incoming, date });

    // Step 6
    const info = db
      .prepare(
        `INSERT INTO transfers (user_id, from_account_id, to_account_id, amount_cents, reference, note)
         VALUES (@userId, @fromId, @toId, @amount, @reference, @note)`,
      )
      .run({
        userId,
        fromId: source.id,
        toId: destination.id,
        amount,
        reference,
        note,
      });

    const transfer = db.prepare(`${TRANSFER_SELECT} WHERE t.id = ? AND t.user_id = ?`).get(info.lastInsertRowid, userId);
    return { transfer, duplicate: false };
  });

  try {
    // immediate() takes the write lock before we read the balance.
    return run.immediate();
  } catch (error) {
    // Two requests with the same reference can pass step 1 together.
    // The unique index rejects the second one, and its balance changes roll back.
    if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const saved = findByReference(userId, String(input.reference ?? '').trim());
      if (saved) return { transfer: saved, duplicate: true };
    }
    throw error;
  }
}
