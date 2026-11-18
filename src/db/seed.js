import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { db, adoptOrphanRows, migrate, periodOf, transaction } from './index.js';
import { ensureDefaultCategories } from './defaults.js';
import { hashPassword } from '../lib/auth.js';

/**
 * Demo wallet for the challenge submission.
 *
 * The data is generated from a fixed seed so every install looks the same, and it
 * deliberately produces a couple of breached budgets so the notification feature is
 * visible straight away. It all belongs to the demo account below, so signing in as
 * another user shows an empty wallet.
 */

export const DEMO_EMAIL = 'demo@pesawallet.com';
export const DEMO_PASSWORD = 'demo1234';

function mulberry32(seedValue) {
  let state = seedValue;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(20260119);
const randomInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
const pick = (items) => items[Math.floor(rng() * items.length)];
const randomAmount = (min, max) => Math.round((min + rng() * (max - min)) / 500) * 500;

const MONTHS_OF_HISTORY = 6;

const ACCOUNTS = [
  { key: 'bank', name: 'Kigali Bank Account', type: 'bank', institution: 'Bank of Kigali', opening: 1_450_000, color: '#4f46e5' },
  // Opening balances are high enough that six months of spending keeps every wallet
  // in credit, which is what a real user's accounts look like.
  { key: 'momo', name: 'MTN Mobile Money', type: 'mobile_money', institution: 'MTN Rwanda', opening: 1_750_000, color: '#f59e0b' },
  { key: 'airtel', name: 'Airtel Money', type: 'mobile_money', institution: 'Airtel Rwanda', opening: 120_000, color: '#ef4444' },
  { key: 'cash', name: 'Cash on Hand', type: 'cash', institution: null, opening: 500_000, color: '#10b981' },
  { key: 'savings', name: 'Emergency Savings', type: 'savings', institution: 'Bank of Kigali', opening: 1_800_000, color: '#0ea5e9' },
];

const FIXED_ENTRIES = [
  { type: 'income', category: 'Base Salary', account: 'bank', amount: 850_000, description: 'Monthly salary — Code of Africa GmbH', day: 1 },
  { type: 'expense', category: 'Rent', account: 'bank', amount: 220_000, description: 'Apartment rent — Kimironko', day: 2 },
  { type: 'expense', category: 'Utilities', account: 'momo', amount: 24_000, description: 'Water & electricity (EUCL prepaid)', day: 5 },
  { type: 'expense', category: 'Internet', account: 'momo', amount: 25_000, description: 'Home fibre internet', day: 6 },
  { type: 'expense', category: 'Gym & Fitness', account: 'momo', amount: 20_000, description: 'Gym membership', day: 7 },
  { type: 'expense', category: 'Groceries', account: 'momo', amount: 42_000, description: 'Monthly grocery run — Simba Supermarket', day: 10 },
  { type: 'expense', category: 'Support', account: 'momo', amount: 50_000, description: 'Monthly family support', day: 15 },
  { type: 'expense', category: 'Streaming', account: 'momo', amount: 8_500, description: 'Netflix & Spotify subscriptions', day: 18 },
  { type: 'expense', category: 'Bank Charges', account: 'bank', amount: 3_500, description: 'Bank account maintenance fee', day: 24 },
  { type: 'expense', category: 'Mobile Money Fees', account: 'momo', amount: 1_500, description: 'Mobile money transfer fees', day: 26 },
];

const VARIABLE_ENTRIES = [
  { type: 'expense', category: 'Groceries', accounts: ['momo', 'cash'], count: [2, 4], amount: [4_000, 16_000], descriptions: ['Groceries — Nyabugogo market', 'Vegetables and fruit', 'Milk, bread and eggs', 'Weekly grocery top-up'] },
  { type: 'expense', category: 'Restaurants', accounts: ['bank', 'cash'], count: [1, 3], amount: [8_000, 26_000], descriptions: ['Lunch at CasaKeza', 'Dinner with friends', 'Brochettes at the corner', 'Sunday brunch'] },
  { type: 'expense', category: 'Coffee & Snacks', accounts: ['cash', 'momo'], count: [3, 6], amount: [1_500, 6_000], descriptions: ['Coffee at Question Coffee', 'Mandazi and tea', 'Afternoon snack', 'Fresh smoothie'] },
  { type: 'expense', category: 'Public Transport', accounts: ['cash'], count: [4, 8], amount: [600, 2_000], descriptions: ['Moto taxi to the office', 'Bus fare', 'Moto taxi home', 'Bus to town'] },
  { type: 'expense', category: 'Fuel', accounts: ['bank'], count: [1, 2], amount: [25_000, 45_000], descriptions: ['Fuel at SP Rwanda', 'Fuel top-up', 'Petrol at Shell'] },
  { type: 'expense', category: 'Ride Hailing', accounts: ['momo'], count: [2, 4], amount: [2_500, 8_000], descriptions: ['Yego Moto ride', 'Move ride to Kacyiru', 'Taxi to the airport'] },
  { type: 'expense', category: 'Clothing', accounts: ['bank'], count: [0, 2], amount: [15_000, 60_000], descriptions: ['T-shirt from Kigali Heights', 'New shoes', 'Work shirts'] },
  { type: 'expense', category: 'Electronics', accounts: ['bank'], count: [0, 1], amount: [20_000, 150_000], descriptions: ['Phone accessories', 'Wireless earbuds', 'Power bank'] },
  { type: 'expense', category: 'Home & Furniture', accounts: ['bank'], count: [0, 1], amount: [15_000, 80_000], descriptions: ['Kitchen utensils', 'Bedsheets', 'Study lamp'] },
  { type: 'expense', category: 'Pharmacy', accounts: ['momo'], count: [0, 2], amount: [3_000, 15_000], descriptions: ['Pharmacy — painkillers', 'Malaria test kit', 'Vitamins'] },
  { type: 'expense', category: 'Doctor Visits', accounts: ['momo'], count: [0, 1], amount: [10_000, 35_000], descriptions: ['Clinic consultation', 'Dental check-up'] },
  { type: 'expense', category: 'Events', accounts: ['momo'], count: [0, 1], amount: [10_000, 35_000], descriptions: ['Concert ticket', 'Wedding contribution', 'Football match'] },
  { type: 'expense', category: 'Hobbies', accounts: ['cash'], count: [0, 2], amount: [5_000, 25_000], descriptions: ['Photography film', 'Board game', 'Hiking trip'] },
  { type: 'expense', category: 'Courses', accounts: ['bank'], count: [0, 1], amount: [30_000, 120_000], descriptions: ['Online course — React patterns', 'Workshop fee'] },
  { type: 'expense', category: 'Books', accounts: ['bank'], count: [0, 1], amount: [8_000, 25_000], descriptions: ['Book from Ikirezi', 'Technical book'] },
  { type: 'expense', category: 'Support', accounts: ['momo'], count: [0, 1], amount: [10_000, 40_000], descriptions: ['Support for a cousin', 'Church contribution'] },
  { type: 'expense', category: 'Gifts', accounts: ['cash'], count: [0, 2], amount: [5_000, 30_000], descriptions: ['Birthday gift', 'Housewarming present'] },
  { type: 'income', category: 'Client Projects', accounts: ['bank'], count: [0, 1], amount: [150_000, 400_000], descriptions: ['Freelance invoice — dashboard build', 'Consulting session', 'Landing page project'] },
  { type: 'income', category: 'Dividends', accounts: ['savings'], count: [0, 1], amount: [8_000, 18_000], descriptions: ['Savings interest', 'Dividend payout'] },
];

const BUDGETS = [
  { category: null, amount: 900_000 },
  { category: 'Food & Dining', amount: 250_000 },
  { category: 'Transport', amount: 90_000 },
  { category: 'Entertainment', amount: 12_000 },
  { category: 'Shopping', amount: 100_000 },
  { category: 'Housing', amount: 300_000 },
];

const pad = (value) => String(value).padStart(2, '0');

/** Create the demo account if it does not exist yet and return its id. */
export function ensureDemoUser() {
  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(DEMO_EMAIL);
  if (existing) return existing.id;

  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run('Eric Nkusi', DEMO_EMAIL, hashPassword(DEMO_PASSWORD));
  return Number(info.lastInsertRowid);
}

/**
 * Populate the demo user's wallet with demo data.
 * @returns {{accounts:number, categories:number, transactions:number, budgets:number}|null}
 *          null when the wallet already has data and `force` is false.
 */
export function seed({ force = false, quiet = false } = {}) {
  migrate();
  const userId = ensureDemoUser();
  adoptOrphanRows(userId);

  const existing = db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE user_id = ?').get(userId).count;
  if (existing > 0 && !force) {
    if (!quiet) console.log('[db] wallet already has data — run "npm run seed" to reset it');
    return null;
  }

  const counts = transaction(() => {
    if (force) {
      // Only the demo wallet is reset; other accounts keep their own data.
      db.prepare('DELETE FROM budgets WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM transactions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM categories WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM accounts WHERE user_id = ?').run(userId);
      try {
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('accounts', 'categories', 'transactions', 'budgets')");
      } catch {
        // sqlite_sequence only exists once an AUTOINCREMENT row has been written.
      }
    }

    const categoryIds = new Map(ensureDefaultCategories(userId).map((row) => [row.name, row.id]));

    const insertAccount = db.prepare(
      `INSERT INTO accounts (user_id, name, type, institution, opening_balance_cents, color)
       VALUES (@user_id, @name, @type, @institution, @opening_balance_cents, @color)`,
    );
    const accountIds = new Map();
    for (const account of ACCOUNTS) {
      const info = insertAccount.run({
        user_id: userId,
        name: account.name,
        type: account.type,
        institution: account.institution,
        opening_balance_cents: account.opening * 100,
        color: account.color,
      });
      accountIds.set(account.key, info.lastInsertRowid);
    }

    // Generate six months of activity, stopping at today for the current month.
    const today = new Date();
    const entries = [];

    for (let monthsAgo = MONTHS_OF_HISTORY - 1; monthsAgo >= 0; monthsAgo -= 1) {
      const monthStart = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
      const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
      const isCurrentMonth = monthsAgo === 0;
      const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;
      const elapsed = lastDay / daysInMonth;
      const period = periodOf(monthStart);

      for (const entry of FIXED_ENTRIES) {
        if (entry.day > lastDay) continue;
        entries.push({ ...entry, accountKey: entry.account, date: `${period}-${pad(entry.day)}` });
      }

      for (const entry of VARIABLE_ENTRIES) {
        const planned = randomInt(entry.count[0], entry.count[1]);
        const occurrences = Math.round(planned * elapsed);
        for (let index = 0; index < occurrences; index += 1) {
          entries.push({
            type: entry.type,
            category: entry.category,
            accountKey: pick(entry.accounts),
            amount: randomAmount(entry.amount[0], entry.amount[1]),
            description: pick(entry.descriptions),
            date: `${period}-${pad(randomInt(1, lastDay))}`,
          });
        }
      }
    }

    entries.sort((a, b) => a.date.localeCompare(b.date));

    const insertTransaction = db.prepare(
      `INSERT INTO transactions (user_id, account_id, category_id, type, amount_cents, description, date)
       VALUES (@user_id, @account_id, @category_id, @type, @amount_cents, @description, @date)`,
    );
    for (const entry of entries) {
      insertTransaction.run({
        user_id: userId,
        account_id: accountIds.get(entry.accountKey),
        category_id: categoryIds.get(entry.category) ?? null,
        type: entry.type,
        amount_cents: entry.amount * 100,
        description: entry.description,
        date: entry.date,
      });
    }

    const insertBudget = db.prepare(
      'INSERT INTO budgets (user_id, category_id, period, amount_cents) VALUES (@user_id, @category_id, @period, @amount_cents)',
    );
    const period = periodOf();
    for (const budget of BUDGETS) {
      insertBudget.run({
        user_id: userId,
        category_id: budget.category ? categoryIds.get(budget.category) : null,
        period,
        amount_cents: budget.amount * 100,
      });
    }

    return {
      accounts: ACCOUNTS.length,
      categories: categoryIds.size,
      transactions: entries.length,
      budgets: BUDGETS.length,
    };
  });

  if (!quiet) {
    console.log(
      `[db] seeded ${counts.transactions} transactions, ${counts.categories} categories, ` +
        `${counts.accounts} accounts and ${counts.budgets} budgets for ${DEMO_EMAIL}`,
    );
  }

  return counts;
}

// `npm run seed` executes this file directly, importing it from the server must not.
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  seed({ force: process.argv.includes('--force') });
  db.close();
}
