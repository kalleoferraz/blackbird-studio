// Empties the local database and library, then rebuilds the schema from the init migration.
// Run with: npm run reset:local   (reads .env.local; DB_HOST must be a local database)
import { dropAllTables, emptyLibrary, libraryRoot } from '../src/db/reset.js';
import { runMigrations } from '../src/db/migrate.js';

const host = process.env.DB_HOST ?? '';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Refusing to reset: DB_HOST is "${host}", not a local database.`);
  process.exit(1);
}
const files = emptyLibrary(libraryRoot());
const tables = await dropAllTables();
await runMigrations();
console.log(`Dropped ${tables.length} tables, removed ${files} library entries, schema rebuilt. Start the app to create the admin.`);
