# Merulo Studio

Hosted web app for writing, recording and organizing a multi-character audiobook, with a DAW-style timeline per section and a provable, incremental history of the text.

Full context: [docs/PROJECT_BIBLE.md](docs/PROJECT_BIBLE.md).

## Status

First working version (everything except audio): accounts and teams, projects, members, Story Index, script writing (scenes, cues, characters, lanes) and Save snapshot. Audio, notes, tasks and references come next (Bible section 2).

## Requirements

Node.js 22 or newer.

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
