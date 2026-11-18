import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ensureDefaultCategories } from '../db/defaults.js';
import { ApiError, conflict } from '../lib/errors.js';
import { loginSchema, parse, registerSchema } from '../lib/validation.js';
import {
  clearSessionCookie,
  createSession,
  createUser,
  destroySession,
  findUserByEmail,
  publicUser,
  readSessionToken,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from '../lib/auth.js';

const router = Router();

// Credential endpoints are the only ones that need more than the global limit.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please try again in a few minutes.' } },
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ data: publicUser(req.user) });
});

router.post('/register', authLimiter, (req, res) => {
  const body = parse(registerSchema, req.body);

  if (findUserByEmail(body.email)) {
    throw conflict('An account with that email already exists. Sign in instead.');
  }

  const user = createUser(body);
  ensureDefaultCategories(user.id);
  setSessionCookie(res, createSession(user.id));

  res.status(201).json({ data: publicUser(user) });
});

router.post('/login', authLimiter, (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = findUserByEmail(body.email);

  // Same message either way so the endpoint cannot be used to discover emails.
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    throw new ApiError(401, 'Email or password is incorrect');
  }

  setSessionCookie(res, createSession(user.id));
  res.json({ data: publicUser(user) });
});

router.post('/logout', (req, res) => {
  destroySession(readSessionToken(req));
  clearSessionCookie(res);
  res.status(204).end();
});

export default router;
