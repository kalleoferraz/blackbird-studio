# Audiobook Studio

Hosted web app for writing, recording and organizing a multi-character audiobook, with a DAW-style timeline per section and a provable, incremental history of the text.

Full context: [docs/PROJECT_BIBLE.md](docs/PROJECT_BIBLE.md).

## Status

Spike finished and cleaned up (Bible section 10). Currently: Fastify skeleton with `/` and `/health`; no features yet.

## Requirements

Node.js 22 or newer.

## Commands

```bash
npm install
cp .env.example .env     # then adjust if needed
npm run dev              # watch mode on http://localhost:3000/health
npm run build            # compile to dist/
npm start                # run the compiled build
```

## Layout

```text
src/server/   Fastify API
docs/         Project Bible
```

Two repos, two jobs: this repo deploys the app; a separate snapshot repo receives text versions at runtime.
