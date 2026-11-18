import 'dotenv/config';
import { createApp } from './app.js';
import { db, adoptOrphanRows, migrate } from './db/index.js';
import { ensureDemoUser, seed } from './db/seed.js';

migrate();

// A fresh install (or a fresh deployment) gets a realistic demo wallet so the app
// is useful the moment it boots. Disable with AUTO_SEED=false.
const seedEnabled = process.env.AUTO_SEED !== 'false';

// Rows created before authentication existed are handed to the demo account. With
// demo seeding disabled, they go to the oldest existing account instead so no
// wallet disappears.
const ownerId = seedEnabled
  ? ensureDemoUser()
  : db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ?? null;

if (ownerId) adoptOrphanRows(ownerId);

const hasData =
  ownerId !== null &&
  db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE user_id = ?').get(ownerId).count > 0;

if (seedEnabled && !hasData) {
  const counts = seed({ force: true, quiet: true });
  console.log(
    `[db] seeded ${counts.transactions} demo transactions across ${counts.accounts} accounts ` +
      'for the demo account',
  );
}

const port = Number(process.env.PORT) || 4000;
const app = createApp();

const server = app.listen(port, () => {
  console.log(`[api] Pesa Wallet API listening on http://localhost:${port}`);
});

function shutdown(signal) {
  console.log(`\n[api] ${signal} received, closing down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
