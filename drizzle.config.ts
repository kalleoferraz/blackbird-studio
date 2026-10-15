import { defineConfig } from 'drizzle-kit';

// Used by `npm run db:generate` to write SQL migrations from src/db/schema.ts.
// Generating needs no database connection; the migrations run from the app (see the Bible, section 4).
export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
