import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import routes from './routes/index.js';
import { ApiError, translateSqliteError } from './lib/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '..', '..', 'client', 'dist');

/** Build the Express application (kept separate from index.js so it is easy to test). */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // The API sits behind the platform proxy in production, which sets X-Forwarded-For.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Session cookies are credentials, so cross-origin access is only allowed when an
  // explicit origin list is configured. Same-origin requests need no CORS headers.
  const allowedOrigins = process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim());
  app.use(cors({ origin: allowedOrigins?.length ? allowedOrigins : false, credentials: true }));

  app.use(express.json({ limit: '100kb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  // Every API response is per user, so no shared cache may keep a copy.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Simple abuse protection: 300 API requests per minute per client.
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.use('/api', routes);

  // Serve the built React app when it exists (single service deployment).
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => {
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  app.use((req, res, next) => {
    next(new ApiError(404, `Route ${req.method} ${req.originalUrl} does not exist`));
  });

  // Central error handler: every failure leaves the API in the same JSON shape.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Request body is not valid JSON' } });
    }

    const sqliteError = translateSqliteError(error);
    const resolved = sqliteError ?? error;
    const status = resolved.status ?? 500;

    if (status >= 500) console.error('[api] unhandled error', error);

    return res.status(status).json({
      error: {
        message: status >= 500 ? 'Something went wrong on our side' : resolved.message,
        details: resolved.details,
      },
    });
  });

  return app;
}
