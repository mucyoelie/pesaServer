import { Router } from 'express';
import { requireAuth } from '../lib/auth.js';
import accountsRouter from './accounts.js';
import authRouter from './auth.js';
import budgetsRouter from './budgets.js';
import categoriesRouter from './categories.js';
import reportsRouter from './reports.js';
import transactionsRouter from './transactions.js';
import transfersRouter from './transfers.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime_seconds: Math.round(process.uptime()) });
});

// Public: register, sign in, sign out and "who am I".
router.use('/auth', authRouter);

// Everything below needs a session; req.user is the signed-in account.
router.use(requireAuth);

router.use('/accounts', accountsRouter);
router.use('/categories', categoriesRouter);
router.use('/transactions', transactionsRouter);
router.use('/transfers', transfersRouter);
router.use('/budgets', budgetsRouter);
router.use('/', reportsRouter);

export default router;
