import { db } from '../db/index.js';

/**
 * Build one user's category tree for one kind ("income" or "expense").
 * Returns `roots` (top level categories with nested children) and a `byId` lookup
 * so callers can roll totals up or down the tree.
 */
export function buildCategoryTree(userId, kind) {
  const rows = db
    .prepare(
      `SELECT id, name, kind, parent_id, color
       FROM categories
       WHERE user_id = ? AND kind = ?
       ORDER BY name COLLATE NOCASE`,
    )
    .all(userId, kind);

  const byId = new Map(
    rows.map((row) => [row.id, { ...row, children: [], total_cents: 0, transaction_count: 0 }]),
  );
  const roots = [];

  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return { roots, byId };
}

/** Attach subtree totals coming from a Map(categoryId -> cents) and return the roots. */
export function applyTotals(tree, totalsById) {
  const walk = (node) => {
    let total = totalsById.get(node.id) ?? 0;
    for (const child of node.children) total += walk(child);
    node.total_cents = total;
    return total;
  };
  tree.roots.forEach(walk);
  return tree.roots;
}

/** Recursively collect the ids of a user's category and all of its descendants. */
export function subtreeIds(userId, categoryId) {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM categories WHERE id = @categoryId AND user_id = @userId
         UNION ALL
         SELECT c.id FROM categories c JOIN sub s ON c.parent_id = s.id
         WHERE c.user_id = @userId
       )
       SELECT id FROM sub`,
    )
    .all({ categoryId, userId });
  return rows.map((row) => row.id);
}

/** Threshold helpers shared by the budgets screen and the notification bell. */
export function budgetStatus(percent) {
  if (percent >= 100) return 'exceeded';
  if (percent >= 80) return 'warning';
  return 'ok';
}
