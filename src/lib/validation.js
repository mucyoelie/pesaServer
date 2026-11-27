import { z } from 'zod';
import { ApiError } from './errors.js';

/** YYYY-MM-DD that also has to be a real calendar date (rejects 2026-02-31). */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'That date does not exist');

/** YYYY-MM, the format used for budget periods. */
export const period = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use the YYYY-MM format');

export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #4f46e5');

/** Money is always handled as integer cents on the API. */
export const cents = z.number().int('Amount must be whole cents').min(-1e12).max(1e12);

const optionalId = z.number().int().positive().nullish();

/** Auth payloads. Emails are normalised so sign in is case insensitive. */
export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(120, 'Email is too long')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Enter a valid email address');

export const password = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(128, 'Password is too long');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(60, 'Name is too long'),
  email,
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
});

const accountTypes = ['bank', 'mobile_money', 'cash', 'savings', 'other'];
const kinds = ['income', 'expense'];

export const accountBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  type: z.enum(accountTypes),
  institution: z.string().trim().max(80).nullish().transform((value) => value || null),
  opening_balance_cents: cents.default(0),
  color: hexColor.default('#6366f1'),
  is_archived: z.boolean().default(false),
});

export const createAccountSchema = accountBody;
export const updateAccountSchema = accountBody.partial();

export const categoryBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(50),
  kind: z.enum(kinds),
  parent_id: optionalId,
  color: hexColor.default('#64748b'),
});

export const createCategorySchema = categoryBody;
export const updateCategorySchema = categoryBody.partial();

export const transactionBody = z.object({
  account_id: z.number().int().positive('Pick an account'),
  category_id: optionalId,
  type: z.enum(kinds),
  amount_cents: z.number().int().positive('Amount must be greater than zero').max(1e12),
  description: z.string().trim().max(160).default(''),
  date: isoDate,
});

export const createTransactionSchema = transactionBody;
export const updateTransactionSchema = transactionBody.partial();

/** Body for POST /api/transfers. `reference` is the idempotency key. */
export const createTransferSchema = z
  .object({
    from_account_id: z.number().int().positive('Pick the account to take money from'),
    to_account_id: z.number().int().positive('Pick the account to send money to'),
    amount_cents: z.number().int().positive('Amount must be greater than zero').max(1e12),
    reference: z.string().trim().min(8, 'Reference is too short').max(80),
    note: z.string().trim().max(160).default(''),
  })
  .refine((body) => body.from_account_id !== body.to_account_id, {
    message: 'Choose two different accounts',
    path: ['to_account_id'],
  });

export const accountQuerySchema = z.object({
  asOf: isoDate.optional(),
});

export const transactionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(kinds).optional(),
  accountId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(80).optional(),
  sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).default('date_desc'),
});

export const reportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const budgetQuerySchema = z.object({
  period: period.optional(),
});

export const budgetBody = z.object({
  period,
  category_id: optionalId,
  amount_cents: z.number().int().positive('Budget must be greater than zero').max(1e12),
});

/**
 * Validate `data` against a schema, throwing a 422 with per-field details when it
 * does not match. Routes stay free of repetitive if/else checks.
 */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  throw new ApiError(
    422,
    'Some fields need attention',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    })),
  );
}
