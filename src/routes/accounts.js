import { Router } from 'express';
import { db } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { parse, createAccountSchema, updateAccountSchema } from '../lib/validation.js';
import { accountBalances } from '../services/analytics.js';

const router = Router();

/** Single account with its live balance, or a 404 when it is not this user's. */
export function getAccount(userId, id) {
  const account = db
    .prepare(
      `SELECT a.id, a.name, a.type, a.institution, a.color, a.is_archived, a.opening_balance_cents,
              a.opening_balance_cents
                + COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END), 0)
                AS balance_cents,
              COUNT(t.id) AS transaction_count
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id
       WHERE a.id = @id AND a.user_id = @userId
       GROUP BY a.id`,
    )
    .get({ id: Number(id), userId });

  if (!account) throw notFound('Account');
  return account;
}

router.get('/', (req, res) => {
  res.json({ data: accountBalances(req.user.id) });
});

router.get('/:id', (req, res) => {
  res.json({ data: getAccount(req.user.id, req.params.id) });
});

router.post('/', (req, res) => {
  const body = parse(createAccountSchema, req.body);
  const info = db
    .prepare(
      `INSERT INTO accounts (user_id, name, type, institution, opening_balance_cents, color, is_archived)
       VALUES (@user_id, @name, @type, @institution, @opening_balance_cents, @color, @is_archived)`,
    )
    .run({ ...body, user_id: req.user.id, is_archived: body.is_archived ? 1 : 0 });

  res.status(201).json({ data: getAccount(req.user.id, info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  getAccount(userId, id); // 404 when missing or owned by someone else
  const body = parse(updateAccountSchema, req.body);

  const editable = ['name', 'type', 'institution', 'opening_balance_cents', 'color', 'is_archived'];
  const assignments = [];
  const params = { id, userId };
  for (const field of editable) {
    if (body[field] === undefined) continue;
    assignments.push(`${field} = @${field}`);
    params[field] = field === 'is_archived' ? (body[field] ? 1 : 0) : body[field];
  }

  if (assignments.length > 0) {
    db.prepare(`UPDATE accounts SET ${assignments.join(', ')} WHERE id = @id AND user_id = @userId`).run(params);
  }
  res.json({ data: getAccount(userId, id) });
});

router.delete('/:id', (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  getAccount(userId, id);
  // Transactions belong to the account, so both go together (ON DELETE CASCADE).
  db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(id, userId);
  res.status(204).end();
});

export default router;
