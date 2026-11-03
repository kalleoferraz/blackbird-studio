# Blackbird Studio

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

Moving a project: on its Project page, **Manage Project** has **Export**, which saves the whole project as one `.zip`: `project.json` (story, notes, characters and the library's file list; no members or snapshots) and all the library's files. **Import** on the Projects page reads such a zip, creates the project and sends its files. If the file's repository folder is already in use you can import into another folder or add the files to the existing project. **Update assets only** puts the files of an exported zip back into the current project, one by one (no request is larger than a single file, 100 MB): missing files are filled in, and for files already there you choose to keep or replace each one. A file marked missing in the Library (red exclamation mark) can be put back with **Re-upload file…**; replacing audio makes a new waveform and adds the task “Check if new audio is fitting” to the cues that play it.

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

In the Library, drag a file onto a folder to move it there; **Rename…** in the file or folder menu renames it. A file's preview lists its notes and the cues that play it; click a cue to jump to it in the script.

Snapshots: the administrator sets the GitHub repository and token in **Administration → Snapshots** (token stored encrypted; **Test connection** checks them). `SNAPSHOT_REPO`, `SNAPSHOT_BRANCH` and `SNAPSHOT_REPO_TOKEN` still work as a fallback.

The library (covers, pictures, uploads) is stored on disk under `LIBRARY_ROOT` (default `./library`, git-ignored). On the host set it to a folder that survives deploys, such as `/private/library`.

Two repos, two jobs: this repo deploys the app; a separate snapshot repo receives text versions at runtime.
