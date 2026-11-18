import { db } from './index.js';

/**
 * The category tree every new wallet starts with. Two levels: a parent such as
 * "Food & Dining" holds "Groceries", "Restaurants" and "Coffee & Snacks".
 * Registration copies this tree for the new user, so a fresh account is usable
 * without any setup.
 */
export const DEFAULT_CATEGORIES = [
  { name: 'Food & Dining', kind: 'expense', color: '#f97316', children: ['Groceries', 'Restaurants', 'Coffee & Snacks'] },
  { name: 'Transport', kind: 'expense', color: '#0ea5e9', children: ['Public Transport', 'Fuel', 'Ride Hailing'] },
  { name: 'Housing', kind: 'expense', color: '#8b5cf6', children: ['Rent', 'Utilities', 'Internet'] },
  { name: 'Shopping', kind: 'expense', color: '#ec4899', children: ['Clothing', 'Electronics', 'Home & Furniture'] },
  { name: 'Health', kind: 'expense', color: '#14b8a6', children: ['Pharmacy', 'Doctor Visits', 'Gym & Fitness'] },
  { name: 'Entertainment', kind: 'expense', color: '#f43f5e', children: ['Streaming', 'Events', 'Hobbies'] },
  { name: 'Education', kind: 'expense', color: '#6366f1', children: ['Courses', 'Books'] },
  { name: 'Bills & Fees', kind: 'expense', color: '#64748b', children: ['Bank Charges', 'Mobile Money Fees'] },
  { name: 'Family & Giving', kind: 'expense', color: '#eab308', children: ['Support', 'Gifts'] },
  { name: 'Salary', kind: 'income', color: '#16a34a', children: ['Base Salary', 'Bonus'] },
  { name: 'Freelance', kind: 'income', color: '#22c55e', children: ['Client Projects', 'Consulting'] },
  { name: 'Investment', kind: 'income', color: '#84cc16', children: ['Dividends', 'Interest'] },
  { name: 'Other Income', kind: 'income', color: '#a3e635', children: ['Refunds', 'Gifts Received'] },
];

/** Insert the default tree for a user and return its `{ id, name }` rows. */
export function createDefaultCategories(userId) {
  const insert = db.prepare(
    'INSERT INTO categories (user_id, name, kind, parent_id, color) VALUES (@user_id, @name, @kind, @parent_id, @color)',
  );

  for (const parent of DEFAULT_CATEGORIES) {
    const parentInfo = insert.run({
      user_id: userId,
      name: parent.name,
      kind: parent.kind,
      parent_id: null,
      color: parent.color,
    });

    for (const child of parent.children) {
      insert.run({
        user_id: userId,
        name: child,
        kind: parent.kind,
        parent_id: parentInfo.lastInsertRowid,
        color: parent.color,
      });
    }
  }

  return db.prepare('SELECT id, name FROM categories WHERE user_id = ?').all(userId);
}

/** Give a user the default categories only when they have none yet. */
export function ensureDefaultCategories(userId) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM categories WHERE user_id = ?').get(userId);
  if (count === 0) return createDefaultCategories(userId);
  return db.prepare('SELECT id, name FROM categories WHERE user_id = ?').all(userId);
}
