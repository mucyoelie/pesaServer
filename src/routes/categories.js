import { Router } from 'express';
import { db } from '../db/index.js';
import { ApiError, notFound } from '../lib/errors.js';
import { parse, createCategorySchema, updateCategorySchema } from '../lib/validation.js';
import { buildCategoryTree } from '../services/categoryTree.js';

const router = Router();

/** Own transaction count and amount for every category id of one user. */
function categoryStats(userId) {
  const rows = db
    .prepare(
      `SELECT category_id, COUNT(*) AS transaction_count, COALESCE(SUM(amount_cents), 0) AS total_cents
       FROM transactions
       WHERE user_id = @userId AND category_id IS NOT NULL
       GROUP BY category_id`,
    )
    .all({ userId });
  return new Map(rows.map((row) => [row.category_id, row]));
}

/** Recursively sum children into their parent so each node shows its subtree usage. */
function decorate(node, stats) {
  const own = stats.get(node.id);
  let transactionCount = own?.transaction_count ?? 0;
  let totalCents = own?.total_cents ?? 0;

  for (const child of node.children) {
    const childTotals = decorate(child, stats);
    transactionCount += childTotals.transactionCount;
    totalCents += childTotals.totalCents;
  }

  node.transaction_count = transactionCount;
  node.total_cents = totalCents;
  return { transactionCount, totalCents };
}

function treeFor(userId, kind, stats) {
  const tree = buildCategoryTree(userId, kind);
  tree.roots.forEach((root) => decorate(root, stats));
  return tree.roots;
}

function findCategory(userId, id) {
  const category = db
    .prepare('SELECT id, name, kind, parent_id, color FROM categories WHERE id = @id AND user_id = @userId')
    .get({ id: Number(id), userId });
  if (!category) throw notFound('Category');
  return category;
}

/**
 * Categories are deliberately two levels deep (category -> subcategory). Enforcing
 * that keeps the picker, rollups and reports predictable.
 */
function assertParentIsValid(userId, { parentId, kind, categoryId = null }) {
  if (parentId == null) return;

  const parent = db
    .prepare('SELECT id, kind, parent_id FROM categories WHERE id = @id AND user_id = @userId')
    .get({ id: parentId, userId });
  if (!parent) throw notFound('Parent category');
  if (parent.kind !== kind) {
    throw new ApiError(422, 'A subcategory must belong to a category of the same kind', [
      { field: 'parent_id', message: 'Parent kind does not match' },
    ]);
  }
  if (parent.parent_id !== null) {
    throw new ApiError(422, 'Categories can only have one level of subcategories', [
      { field: 'parent_id', message: 'Pick a top level category' },
    ]);
  }
  if (categoryId !== null && parent.id === categoryId) {
    throw new ApiError(422, 'A category cannot be its own parent', [
      { field: 'parent_id', message: 'Pick a different parent' },
    ]);
  }
}

router.get('/', (req, res) => {
  const userId = req.user.id;
  const stats = categoryStats(userId);
  res.json({ data: { expense: treeFor(userId, 'expense', stats), income: treeFor(userId, 'income', stats) } });
});

router.post('/', (req, res) => {
  const userId = req.user.id;
  const body = parse(createCategorySchema, req.body);
  assertParentIsValid(userId, { parentId: body.parent_id ?? null, kind: body.kind });

  const info = db
    .prepare(
      'INSERT INTO categories (user_id, name, kind, parent_id, color) VALUES (@user_id, @name, @kind, @parent_id, @color)',
    )
    .run({ ...body, user_id: userId, parent_id: body.parent_id ?? null });

  res.status(201).json({ data: findCategory(userId, info.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const userId = req.user.id;
  const existing = findCategory(userId, req.params.id);
  const body = parse(updateCategorySchema, req.body);

  if (body.kind !== undefined && body.kind !== existing.kind) {
    const { total } = db
      .prepare('SELECT COUNT(*) AS total FROM transactions WHERE category_id = @id AND user_id = @userId')
      .get({ id: existing.id, userId });
    if (total > 0) {
      throw new ApiError(422, 'This category already has transactions and cannot change kind', [
        { field: 'kind', message: 'Delete or re-assign its transactions first' },
      ]);
    }
  }

  const kind = body.kind ?? existing.kind;
  const parentId = body.parent_id === undefined ? existing.parent_id : body.parent_id ?? null;

  if (parentId !== null) {
    const childCount = db
      .prepare('SELECT COUNT(*) AS total FROM categories WHERE parent_id = @id AND user_id = @userId')
      .get({ id: existing.id, userId }).total;
    if (childCount > 0) {
      throw new ApiError(422, 'A category with subcategories cannot become a subcategory', [
        { field: 'parent_id', message: 'Move or delete its subcategories first' },
      ]);
    }
  }

  assertParentIsValid(userId, { parentId, kind, categoryId: existing.id });

  const editable = ['name', 'kind', 'color'];
  const assignments = [];
  const params = { id: existing.id, userId, parent_id: parentId };
  for (const field of editable) {
    if (body[field] === undefined) continue;
    assignments.push(`${field} = @${field}`);
    params[field] = body[field];
  }
  assignments.push('parent_id = @parent_id');

  db.prepare(`UPDATE categories SET ${assignments.join(', ')} WHERE id = @id AND user_id = @userId`).run(params);

  // Moving a category also moves its subtree, keep both sides consistent.
  if (parentId !== null && body.kind) {
    db.prepare('UPDATE categories SET kind = @kind WHERE parent_id = @id AND user_id = @userId').run({
      kind,
      id: existing.id,
      userId,
    });
  }

  res.json({ data: findCategory(userId, existing.id) });
});

router.delete('/:id', (req, res) => {
  const userId = req.user.id;
  const existing = findCategory(userId, req.params.id);
  const children = db
    .prepare('SELECT COUNT(*) AS total FROM categories WHERE parent_id = @id AND user_id = @userId')
    .get({ id: existing.id, userId }).total;
  const transactions = db
    .prepare('SELECT COUNT(*) AS total FROM transactions WHERE category_id = @id AND user_id = @userId')
    .get({ id: existing.id, userId }).total;

  // Subcategories cascade, transactions keep their history and become uncategorised.
  db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(existing.id, userId);

  res.json({
    data: { id: existing.id, deleted_subcategories: children, uncategorised_transactions: transactions },
  });
});

export default router;
