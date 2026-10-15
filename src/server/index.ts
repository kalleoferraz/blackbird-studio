import { buildApp } from './app.js';
import { bootstrapAccounts } from '../auth/accounts.js';
import { sessionConfigured } from '../auth/session.js';
import { runMigrations } from '../db/migrate.js';

const app = buildApp();

try {
  // Apply pending database migrations before accepting requests. Without database settings
  // (a local run with no .env) the app starts anyway, since the health check must still answer.
  if (process.env.DB_HOST) {
    await runMigrations();
    app.log.info('Database migrations are up to date');
    await bootstrapAccounts(app.log);
  } else {
    app.log.warn('DB_HOST is not set: skipping database migrations');
  }
  if (!sessionConfigured()) {
    app.log.error('SESSION_SECRET is missing or shorter than 32 characters: login is disabled');
  }
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
