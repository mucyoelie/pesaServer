import { Router } from 'express';
import { periodOf } from '../db/index.js';
import { parse, reportQuerySchema } from '../lib/validation.js';
import {
  accountActivity,
  accountBalances,
  budgetOverview,
  currentPeriodRange,
  expenseTree,
  incomeTree,
  monthlySeries,
  recentMonths,
  recentTransactions,
  topExpenses,
  totalBalance,
  totals,
  transactionsInRange,
} from '../services/analytics.js';

const router = Router();

/** Default range: the current calendar month. */
function resolveRange(query) {
  const current = currentPeriodRange();
  return {
    from: query.from ?? current.from,
    to: query.to ?? current.to,
    isCurrentMonth: (query.from ?? current.from) === current.from && (query.to ?? current.to) === current.to,
  };
}

/** Everything the dashboard needs in a single round trip. */
router.get('/summary', (req, res) => {
  const userId = req.user.id;
  const query = parse(reportQuerySchema, req.query);
  const range = resolveRange(query);
  const expenses = expenseTree(userId, range.from, range.to);

  res.json({
    data: {
      range: { from: range.from, to: range.to },
      totals: totals(userId, range.from, range.to),
      total_balance_cents: totalBalance(userId),
      accounts: accountBalances(userId),
      monthly: recentMonths(userId, 6),
      categories: expenses.roots,
      uncategorized_cents: expenses.uncategorized.total_cents,
      uncategorized_count: expenses.uncategorized.transaction_count,
      recent_transactions: recentTransactions(userId, 6),
      budget_alerts: budgetOverview(userId, periodOf()).alerts,
    },
  });
});

/** Full report for any date range: totals, breakdowns, monthly series, top expenses. */
router.get('/reports', (req, res) => {
  const userId = req.user.id;
  const query = parse(reportQuerySchema, req.query);
  const range = resolveRange(query);

  res.json({
    data: {
      range: { from: range.from, to: range.to },
      totals: totals(userId, range.from, range.to),
      expense_categories: expenseTree(userId, range.from, range.to),
      income_categories: incomeTree(userId, range.from, range.to),
      accounts: accountActivity(userId, range.from, range.to),
      monthly: monthlySeries(userId, range.from, range.to),
      top_expenses: topExpenses(userId, range.from, range.to, 5),
      transaction_count: totals(userId, range.from, range.to).transaction_count,
    },
  });
});

router.get('/reports/export', (req, res) => {
  const query = parse(reportQuerySchema, req.query);
  const range = resolveRange(query);
  const rows = transactionsInRange(req.user.id, range.from, range.to);

  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['Date', 'Type', 'Account', 'Category', 'Subcategory', 'Description', 'Amount (RWF)'];
  const lines = rows.map((row) =>
    [
      row.date,
      row.type,
      row.account_name,
      row.parent_category_name ?? row.category_name ?? 'Uncategorised',
      row.parent_category_name ? row.category_name : '',
      row.description,
      (row.amount_cents / 100).toFixed(2),
    ]
      .map(escape)
      .join(','),
  );

  const csv = `\ufeff${[header.map(escape).join(','), ...lines].join('\r\n')}\r\n`;
  const filename = `pesa-wallet-report_${range.from}_to_${range.to}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

export default router;
