import { db, periodOf } from '../db/index.js';
import { applyTotals, buildCategoryTree, budgetStatus } from './categoryTree.js';

/** First and last day of a YYYY-MM period, as ISO dates. */
export function periodRange(period) {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, '0')}` };
}

export function currentPeriodRange() {
  return periodRange(periodOf());
}

/** Income / expense / net for a date range (inclusive on both ends). */
export function totals(userId, from, to) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income'  THEN amount_cents END), 0) AS income_cents,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense_cents,
         COALESCE(SUM(CASE WHEN type = 'income'  THEN 1 ELSE 0 END), 0) AS income_count,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN 1 ELSE 0 END), 0) AS expense_count,
         COUNT(*) AS transaction_count
       FROM transactions
       WHERE user_id = @userId AND date BETWEEN @from AND @to`,
    )
    .get({ userId, from, to });

  return { ...row, net_cents: row.income_cents - row.expense_cents };
}

/**
 * Total money currently held across every active account.
 * The two halves are separate sub-queries on purpose: joining accounts to
 * transactions would repeat each opening balance once per transaction.
 */
export function totalBalance(userId) {
  const row = db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(opening_balance_cents), 0)
            FROM accounts WHERE user_id = @userId AND is_archived = 0)
         + (SELECT COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END), 0)
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
            WHERE a.user_id = @userId AND a.is_archived = 0) AS total_cents`,
    )
    .get({ userId });
  return row.total_cents;
}

/** Every account with its live balance, transaction count and archived flag. */
export function accountBalances(userId, asOf = '9999-12-31') {
  return db
    .prepare(
      `SELECT a.id, a.name, a.type, a.institution, a.color, a.is_archived,
              a.opening_balance_cents,
              a.opening_balance_cents
                + COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END), 0)
                AS balance_cents,
              COALESCE(SUM(CASE WHEN t.type = 'income'  THEN t.amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents,
              COUNT(t.id) AS transaction_count
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id AND t.date <= @asOf
       WHERE a.user_id = @userId
       GROUP BY a.id
       ORDER BY balance_cents DESC, a.name COLLATE NOCASE`,
    )
    .all({ userId, asOf });
}

/**
 * Income vs expenses per month, with months that have no transactions filled in so
 * charts never show gaps.
 */
export function monthlySeries(userId, from, to) {
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS period,
              COALESCE(SUM(CASE WHEN type = 'income'  THEN amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount_cents END), 0) AS expense_cents
       FROM transactions
       WHERE user_id = @userId AND date BETWEEN @from AND @to
       GROUP BY period
       ORDER BY period`,
    )
    .all({ userId, from, to });

  const byPeriod = new Map(rows.map((row) => [row.period, row]));
  const series = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00`);

  while (cursor <= end) {
    const key = periodOf(cursor);
    const row = byPeriod.get(key);
    series.push({
      period: key,
      income_cents: row?.income_cents ?? 0,
      expense_cents: row?.expense_cents ?? 0,
      net_cents: (row?.income_cents ?? 0) - (row?.expense_cents ?? 0),
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return series;
}

/** The last `count` months ending with the current one. */
export function recentMonths(userId, count = 6) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (count - 1), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const from = periodOf(start) + '-01';
  const to = `${periodOf(now)}-${String(lastDay).padStart(2, '0')}`;
  return monthlySeries(userId, from, to);
}

/** Expense category tree for a range, with revenue rolled up into parents. */
export function expenseTree(userId, from, to) {
  const tree = buildCategoryTree(userId, 'expense');
  const rows = db
    .prepare(
      `SELECT category_id, SUM(amount_cents) AS total_cents
       FROM transactions
       WHERE user_id = @userId AND type = 'expense' AND category_id IS NOT NULL
         AND date BETWEEN @from AND @to
       GROUP BY category_id`,
    )
    .all({ userId, from, to });

  applyTotals(tree, new Map(rows.map((row) => [row.category_id, row.total_cents])));

  const uncategorized = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents, COUNT(*) AS transaction_count
       FROM transactions
       WHERE user_id = @userId AND type = 'expense' AND category_id IS NULL
         AND date BETWEEN @from AND @to`,
    )
    .get({ userId, from, to });

  return { roots: tree.roots, uncategorized };
}

/** Income category tree for a range (same shape as expenseTree). */
export function incomeTree(userId, from, to) {
  const tree = buildCategoryTree(userId, 'income');
  const rows = db
    .prepare(
      `SELECT category_id, SUM(amount_cents) AS total_cents
       FROM transactions
       WHERE user_id = @userId AND type = 'income' AND category_id IS NOT NULL
         AND date BETWEEN @from AND @to
       GROUP BY category_id`,
    )
    .all({ userId, from, to });

  applyTotals(tree, new Map(rows.map((row) => [row.category_id, row.total_cents])));

  const uncategorized = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents, COUNT(*) AS transaction_count
       FROM transactions
       WHERE user_id = @userId AND type = 'income' AND category_id IS NULL
         AND date BETWEEN @from AND @to`,
    )
    .get({ userId, from, to });

  return { roots: tree.roots, uncategorized };
}

/** Per account income, expense and closing balance inside a range. */
export function accountActivity(userId, from, to) {
  return db
    .prepare(
      `SELECT a.id, a.name, a.type, a.institution, a.color,
              a.opening_balance_cents
                + COALESCE(SUM(CASE WHEN t.date < @from THEN
                    CASE WHEN t.type = 'income' THEN t.amount_cents ELSE -t.amount_cents END END), 0)
                AS opening_balance_range_cents,
              COALESCE(SUM(CASE WHEN t.date BETWEEN @from AND @to AND t.type = 'income'  THEN t.amount_cents END), 0) AS income_cents,
              COALESCE(SUM(CASE WHEN t.date BETWEEN @from AND @to AND t.type = 'expense' THEN t.amount_cents END), 0) AS expense_cents
       FROM accounts a
       LEFT JOIN transactions t ON t.account_id = a.id AND t.date <= @to
       WHERE a.user_id = @userId
       GROUP BY a.id
       ORDER BY a.name COLLATE NOCASE`,
    )
    .all({ userId, from, to })
    .map((row) => ({
      ...row,
      net_cents: row.income_cents - row.expense_cents,
      closing_balance_cents: row.opening_balance_range_cents + row.income_cents - row.expense_cents,
    }));
}

const TRANSACTION_SELECT = `
  SELECT t.id, t.account_id, t.category_id, t.type, t.amount_cents, t.description, t.date, t.created_at,
         a.name  AS account_name,
         a.type  AS account_type,
         a.color AS account_color,
         c.name  AS category_name,
         COALESCE(c.color, p.color) AS category_color,
         p.name  AS parent_category_name,
         p.id    AS parent_category_id
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories p ON p.id = c.parent_id
`;

export const SORTS = {
  date_desc: 't.date DESC, t.id DESC',
  date_asc: 't.date ASC, t.id ASC',
  amount_desc: 't.amount_cents DESC, t.date DESC',
  amount_asc: 't.amount_cents ASC, t.date DESC',
};

/** `where` must already be scoped to a user and `params` must carry its userId. */
export function listTransactions({ where = '', params = {}, sort = 'date_desc', limit, offset } = {}) {
  const order = SORTS[sort] ?? SORTS.date_desc;
  const pagination = limit ? 'LIMIT @limit OFFSET @offset' : '';
  const sql = `${TRANSACTION_SELECT} ${where} ORDER BY ${order} ${pagination}`;
  // better-sqlite3 rejects bind objects carrying keys the statement does not use,
  // so limit/offset are only added when the pagination clause is present.
  return db.prepare(sql).all(limit ? { ...params, limit, offset: offset ?? 0 } : { ...params });
}

/** Every transaction in a range, used by the CSV export. */
export function transactionsInRange(userId, from, to) {
  return db
    .prepare(
      `${TRANSACTION_SELECT} WHERE t.user_id = @userId AND t.date BETWEEN @from AND @to
       ORDER BY t.date ASC, t.id ASC`,
    )
    .all({ userId, from, to });
}

export function recentTransactions(userId, limit = 6) {
  return listTransactions({
    where: 'WHERE t.user_id = @userId',
    params: { userId },
    limit,
    offset: 0,
  });
}

export function findTransaction(userId, id) {
  return db.prepare(`${TRANSACTION_SELECT} WHERE t.id = @id AND t.user_id = @userId`).get({ id, userId });
}

/** Top expenses by amount in a range, useful for the reports page. */
export function topExpenses(userId, from, to, limit = 5) {
  return db
    .prepare(
      `${TRANSACTION_SELECT}
       WHERE t.user_id = @userId AND t.type = 'expense' AND t.date BETWEEN @from AND @to
       ORDER BY t.amount_cents DESC LIMIT @limit`,
    )
    .all({ userId, from, to, limit });
}

/**
 * Budget state for a period: amount, what has been spent (including subcategories),
 * remaining and status. Used by the budgets screen, the dashboard banner and the
 * "you just exceeded a budget" check after saving a transaction.
 */
export function budgetOverview(userId, period) {
  const { from, to } = periodRange(period);
  const treeRows = expenseTree(userId, from, to);
  const spentById = new Map();
  const collect = (node) => {
    spentById.set(node.id, node.total_cents);
    node.children.forEach(collect);
  };
  treeRows.roots.forEach(collect);

  const periodTotals = totals(userId, from, to);
  const expenseTotal = periodTotals.expense_cents;

  const rows = db
    .prepare(
      `SELECT b.id, b.category_id, b.period, b.amount_cents, c.name AS category_name, c.color AS category_color
       FROM budgets b
       LEFT JOIN categories c ON c.id = b.category_id
       WHERE b.user_id = @userId AND b.period = @period
       ORDER BY b.category_id IS NOT NULL, b.amount_cents DESC`,
    )
    .all({ userId, period });

  const budgets = rows.map((row) => {
    const spent = row.category_id ? spentById.get(row.category_id) ?? 0 : expenseTotal;
    const percent = row.amount_cents > 0 ? Math.round((spent / row.amount_cents) * 1000) / 10 : 0;
    return {
      ...row,
      spent_cents: spent,
      remaining_cents: row.amount_cents - spent,
      percent,
      status: budgetStatus(percent),
    };
  });

  const alerts = budgets
    .filter((budget) => budget.status !== 'ok')
    .sort((a, b) => b.percent - a.percent)
    .map((budget) => ({
      id: budget.id,
      category_id: budget.category_id,
      category_name: budget.category_name ?? 'Overall budget',
      amount_cents: budget.amount_cents,
      spent_cents: budget.spent_cents,
      remaining_cents: budget.remaining_cents,
      percent: budget.percent,
      status: budget.status,
    }));

  const overall = budgets.find((budget) => budget.category_id === null) ?? null;

  return {
    period,
    from,
    to,
    budgets,
    overall,
    alerts,
    totals: {
      budget_cents: budgets.reduce((sum, budget) => sum + budget.amount_cents, 0),
      spent_cents: expenseTotal,
      transaction_count: periodTotals.transaction_count,
    },
  };
}
