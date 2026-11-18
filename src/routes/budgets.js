import { Router } from 'express';
import { db, periodOf } from '../db/index.js';
import { ApiError, notFound } from '../lib/errors.js';
import { parse, budgetBody, budgetQuerySchema } from '../lib/validation.js';
import { budgetOverview } from '../services/analytics.js';

const router = Router();

router.get('/', (req, res) => {
  const query = parse(budgetQuerySchema, req.query);
  const period = query.period ?? periodOf();
  res.json({ data: budgetOverview(req.user.id, period) });
});

/**
 * Create or update the budget for a period + category in one call. The UI uses a
 * single "set budget" form, so an upsert keeps the client simple.
 */
router.post('/', (req, res) => {
  const userId = req.user.id;
  const body = parse(budgetBody, req.body);
  const categoryId = body.category_id ?? null;

  if (categoryId !== null) {
    const category = db
      .prepare('SELECT id, kind FROM categories WHERE id = @id AND user_id = @userId')
      .get({ id: categoryId, userId });
    if (!category) {
      throw new ApiError(422, 'That category does not exist', [
        { field: 'category_id', message: 'Unknown category' },
      ]);
    }
    if (category.kind !== 'expense') {
      throw new ApiError(422, 'Budgets can only be set on expense categories', [
        { field: 'category_id', message: 'Pick an expense category' },
      ]);
    }
  }

  const existing = db
    .prepare(
      `SELECT id FROM budgets
       WHERE user_id = @userId AND period = @period AND ifnull(category_id, 0) = ifnull(@categoryId, 0)`,
    )
    .get({ userId, period: body.period, categoryId });

  if (existing) {
    db.prepare('UPDATE budgets SET amount_cents = ? WHERE id = ? AND user_id = ?').run(
      body.amount_cents,
      existing.id,
      userId,
    );
  } else {
    db.prepare(
      'INSERT INTO budgets (user_id, category_id, period, amount_cents) VALUES (@userId, @categoryId, @period, @amount)',
    ).run({
      userId,
      categoryId,
      period: body.period,
      amount: body.amount_cents,
    });
  }

  res.status(existing ? 200 : 201).json({ data: budgetOverview(userId, body.period) });
});

router.delete('/:id', (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  const budget = db.prepare('SELECT id FROM budgets WHERE id = ? AND user_id = ?').get(id, userId);
  if (!budget) throw notFound('Budget');
  db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(id, userId);
  res.status(204).end();
});

export default router;
