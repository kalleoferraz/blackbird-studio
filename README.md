# Merulo Studio

Hosted web app for writing, recording and organizing a multi-character audiobook, with a DAW-style timeline per section and a provable, incremental history of the text.

Full context: [docs/PROJECT_BIBLE.md](docs/PROJECT_BIBLE.md).

## Status

First working version (everything except audio): accounts and teams, projects, members, Story Index, script writing (scenes, cues, characters, lanes) and Save snapshot. Audio, notes, tasks and references come next (Bible section 2).

## Requirements

Node.js 22 or newer.

## Quick start (fresh install)

```bash
npm install
cp .env.example .env.local        # set DB_*, SESSION_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters)
scripts/local-db-setup.sh         # creates the local MySQL database and user named in .env.local
npm run dev                       # creates every table (drizzle/0000_init.sql) and the admin account, then serves :3000
```

The whole schema is one baseline migration, `drizzle/0000_init.sql`, applied by the app at startup. Later schema changes are added on top of it with `npm run db:generate`. `npm run reset:local` empties the local database and library and rebuilds the schema.

On the host (no shell): to start over, set `RESET_ALL_DATA` to a new tag (for example `2026-10-22`), deploy, and remove the variable after the first healthy start. It drops every table, empties the library folder and rebuilds the schema once; see Bible section 4, Migrations.

## Commands

```bash
npm install
cp .env.example .env     # then adjust if needed
npm run dev              # watch mode on http://localhost:3000/health
npm run web:build        # build the React app into public/app (commit the result)
npm run build            # compile the server to dist/
npm test                 # integration tests (need a MySQL/MariaDB test database, see test/api.test.ts)
npm start                # run the compiled build
```

## Layout

```text
src/server/   Fastify API
src/snapshot/ snapshot files and the GitHub version store
web/          React app (Vite); builds into public/app
docs/         Project Bible
```

The library (covers, pictures, uploads) is stored on disk under `LIBRARY_ROOT` (default `./library`, git-ignored). On the host set it to a folder that survives deploys, such as `/private/library`.

Two repos, two jobs: this repo deploys the app; a separate snapshot repo receives text versions at runtime.
