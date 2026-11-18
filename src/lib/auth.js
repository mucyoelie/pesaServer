import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { ApiError } from './errors.js';

const COOKIE_NAME = 'pesa_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) > 0 ? Number(process.env.SESSION_DAYS) : 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Hash a password with scrypt and a per-user random salt. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant time check of a password against a stored `scrypt:salt:hash` value. */
export function verifyPassword(password, storedHash) {
  const [scheme, saltHex, hashHex] = String(storedHash ?? '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;

  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** The shape of a user that is safe to send to the browser (no password hash). */
export function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
}

export function findUserByEmail(email) {
  return db
    .prepare('SELECT id, name, email, password_hash, created_at FROM users WHERE lower(email) = lower(?)')
    .get(email);
}

export function createUser({ name, email, password }) {
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (@name, @email, @password_hash)')
    .run({ name, email, password_hash: hashPassword(password) });

  return db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/** Create a session and return the raw token; only its hash is stored. */
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    userId,
    Date.now() + SESSION_MS,
  );
  // Housekeeping: drop sessions that can no longer be used.
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  return token;
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userForToken(token) {
  if (!token) return null;
  const user = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Date.now());
  return user ?? null;
}

/** Read the session cookie without pulling in another dependency. */
export function readSessionToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    return decodeURIComponent(part.slice(separator + 1).trim()) || null;
  }
  return null;
}

function cookieAttributes() {
  const attributes = ['Path=/', 'HttpOnly'];
  if (process.env.NODE_ENV === 'production') {
    attributes.push('SameSite=None', 'Secure');
  } else {
    attributes.push('SameSite=Lax');
  }
  return attributes;
}

export function setSessionCookie(res, token) {
  res.append(
    'Set-Cookie',
    [`${COOKIE_NAME}=${token}`, ...cookieAttributes(), `Max-Age=${Math.floor(SESSION_MS / 1000)}`].join('; '),
  );
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', [`${COOKIE_NAME}=`, ...cookieAttributes(), 'Max-Age=0'].join('; '));
}

/** Middleware: require a valid session and attach the user to the request. */
export function requireAuth(req, res, next) {
  const user = userForToken(readSessionToken(req));
  if (!user) return next(new ApiError(401, 'Sign in to continue'));
  req.user = user;
  return next();
}
