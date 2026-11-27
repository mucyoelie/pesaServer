import { Router } from 'express';
import { db } from '../db/index.js';
import { ApiError, notFound } from '../lib/errors.js';
import {
  parse,
  createTransactionSchema,
  updateTransactionSchema,
  transactionQuerySchema,
} from '../lib/validation.js';
import {
  budgetOverview,
  findTransaction,
  listTransactions,
  SORTS,
} from '../services/analytics.js';
import { subtreeIds } from '../services/categoryTree.js';

const router = Router();

/** A transaction may only point at this user's account and a category of matching kind. */
function assertLinks(userId, { account_id, category_id, type }) {
  if (account_id !== undefined) {
    const account = db
      .prepare('SELECT id FROM accounts WHERE id = @id AND user_id = @userId')
      .get({ id: account_id, userId });
    if (!account) {
      throw new ApiError(422, 'That account does not exist', [{ field: 'account_id', message: 'Unknown account' }]);
    }
  }

  if (category_id !== undefined && category_id !== null) {
    const category = db
      .prepare('SELECT id, kind FROM categories WHERE id = @id AND user_id = @userId')
      .get({ id: category_id, userId });
    if (!category) {
      throw new ApiError(422, 'That category does not exist', [
        { field: 'category_id', message: 'Unknown category' },
      ]);
    }
    if (type !== undefined && category.kind !== type) {
      throw new ApiError(422, `Pick a ${type} category — this one is for ${category.kind}`, [
        { field: 'category_id', message: 'Category kind does not match the transaction type' },
      ]);
    }
  }
}

/**
 * Only tell the caller about budgets that are now over their limit, so the UI can
 * raise a notification straight after the expense is saved.
 */
function exceededBudgetsFor(userId, period) {
  return budgetOverview(userId, period).alerts.filter((alert) => alert.status === 'exceeded');
}

function buildFilters(query) {
  const clauses = [];
  const params = {};

  if (query.type) {
    clauses.push('t.type = @type');
    params.type = query.type;
  }
  if (query.accountId) {
    clauses.push('t.account_id = @accountId');
    params.accountId = query.accountId;
  }
  if (query.categoryId) {
    const ids = subtreeIds(query.userId, query.categoryId);
    if (ids.length === 0) throw notFound('Category');
    const placeholders = ids.map((_, index) => `@category${index}`);
    clauses.push(`t.category_id IN (${placeholders.join(', ')})`);
    ids.forEach((id, index) => {
      params[`category${index}`] = id;
    });
  }
  if (query.from) {
    clauses.push('t.date >= @from');
    params.from = query.from;
  }
  if (query.to) {
    clauses.push('t.date <= @to');
    params.to = query.to;
  }
  if (query.q) {
    clauses.push('(t.description LIKE @q OR a.name LIKE @q OR c.name LIKE @q)');
    params.q = `%${query.q}%`;
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Every list query is limited to the signed-in user's ledger. */
function scope(userId, where) {
  return where ? `${where} AND t.user_id = @userId` : 'WHERE t.user_id = @userId';
}

router.get('/', (req, res) => {
  const userId = req.user.id;
  const query = parse(transactionQuerySchema, req.query);
  const { where, params } = buildFilters({ ...query, userId });
  const scopedWhere = scope(userId, where);
  const scopedParams = { ...params, userId };

  const aggregates = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN t.type = 'income'  AND t.is_transfer = 0 THEN t.amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.is_transfer = 0 THEN t.amount_cents END), 0) AS expense_cents
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id
       ${scopedWhere}`,
    )
    .get(scopedParams);

  const offset = (query.page - 1) * query.pageSize;
  const data = listTransactions({
    where: scopedWhere,
    params: scopedParams,
    sort: query.sort,
    limit: query.pageSize,
    offset,
  });

  res.json({
    data,
    meta: {
      page: query.page,
      pageSize: query.pageSize,
      total: aggregates.total,
      totalPages: Math.max(1, Math.ceil(aggregates.total / query.pageSize)),
      totals: { income_cents: aggregates.income_cents, expense_cents: aggregates.expense_cents },
      sort: query.sort,
      sorts: Object.keys(SORTS),
    },
  });
});

router.get('/:id', (req, res) => {
  const transaction = findTransaction(req.user.id, Number(req.params.id));
  if (!transaction) throw notFound('Transaction');
  res.json({ data: transaction });
});

router.post('/', (req, res) => {
  const userId = req.user.id;
  const body = parse(createTransactionSchema, req.body);
  assertLinks(userId, body);

  const info = db
    .prepare(
      `INSERT INTO transactions (user_id, account_id, category_id, type, amount_cents, description, date)
       VALUES (@user_id, @account_id, @category_id, @type, @amount_cents, @description, @date)`,
    )
    .run({ ...body, user_id: userId, category_id: body.category_id ?? null });

  const transaction = findTransaction(userId, info.lastInsertRowid);
  const budgetAlerts = body.type === 'expense' ? exceededBudgetsFor(userId, body.date.slice(0, 7)) : [];

  res.status(201).json({ data: transaction, meta: { budget_alerts: budgetAlerts } });
});

router.put('/:id', (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  const existing = findTransaction(userId, id);
  if (!existing) throw notFound('Transaction');

  const body = parse(updateTransactionSchema, req.body);
  assertLinks(userId, {
    account_id: body.account_id,
    category_id: body.category_id,
    type: body.type ?? existing.type,
  });

  const editable = ['account_id', 'category_id', 'type', 'amount_cents', 'description', 'date'];
  const assignments = [];
  const params = { id, userId };
  for (const field of editable) {
    if (body[field] === undefined) continue;
    assignments.push(`${field} = @${field}`);
    params[field] = field === 'category_id' ? body[field] ?? null : body[field];
  }

  if (assignments.length > 0) {
    db.prepare(`UPDATE transactions SET ${assignments.join(', ')} WHERE id = @id AND user_id = @userId`).run(params);
  }

  const transaction = findTransaction(userId, id);
  const budgetAlerts =
    transaction.type === 'expense' ? exceededBudgetsFor(userId, transaction.date.slice(0, 7)) : [];

  res.json({ data: transaction, meta: { budget_alerts: budgetAlerts } });
});

router.delete('/:id', (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!findTransaction(userId, id)) throw notFound('Transaction');
  db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(id, userId);
  res.status(204).end();
});

export default router;
