import { buildApp } from './app.js';
import { runMigrations } from '../db/migrate.js';

const app = buildApp();

try {
  // Apply pending database migrations before accepting requests. Without database settings
  // (a local run with no .env) the app starts anyway, since the health check must still answer.
  if (process.env.DB_HOST) {
    await runMigrations();
    app.log.info('Database migrations are up to date');
  } else {
    app.log.warn('DB_HOST is not set: skipping database migrations');
  }
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
