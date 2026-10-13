# Audiobook Studio — Project Bible

Sep 30, 2026 · @Kalleo · Updated Oct 13, 2026

## 1. Vision and users

Audiobook Studio is a hosted web app where an author writes, records and organizes a multi-character audiobook in one place, with a DAW-style timeline for every section and a provable, incremental history of the written text.

- **Primary user (today):** the owner, a former developer and project manager producing a multi-character fiction audiobook with free, open-source tools.
- **Later users:** other authors and narrators, invited per book, each with a role.
- **Core problem:** text, recordings, sound effects, music and translations live in scattered folders and tools, with no structure linking a line of text to its audio.
- **Product principle:** the text is the spine. Every take, effect and translation attaches to a stable segment of the story.

## 2. v1 scope and not-now list

v1 delivers login, books, a text editor with structure, a basic multi-track timeline, a file library and saved versions. Everything else waits.

**In v1**

- **Accounts:** login, a list of books per user, roles per book (author, narrator, translator) stored from day one even if only "owner" is used at first.
- **Redaction View:** the book is divided into chapters, sections and segments. Each section reads like a DAW timeline, where every layer (track) is a character's speech, a sound effect or a music track. Audio can be recorded in the browser or assigned from the library.
- **Timeline basics:** multiple tracks, draggable and trimmable clips, waveform display, play and seek, record into a segment.
- **Library:** per book, a set of files (audio, pictures, anything) stored on the server behind `BlobStore`.
- **Versions:** a "save version" action plus incremental autosave snapshots of the text to a public GitHub repo.

**Not now**

- Translation view, integrated LLM, text-to-speech, speech-to-speech, audio compiler (see section 7).
- Google Drive as audio storage (see section 7). v1 stores files on the server.
- Effects, automation and crossfades on the timeline.
- Live multi-user editing and websockets.
- Typed-versus-pasted tracking and an edit-event log for provenance.
- Audio versioning as proof of authorship (only the text is proven).

## 3. Architecture principles

The database holds live working state, Git holds text snapshots, and server-side blob storage holds immutable audio, so no single store has to do everything.

1. **The timeline is a description, not audio.** Each section's timeline is JSON (tracks, clips, offsets, trims, gain) that references audio files by ID and hash. Moving or trimming a clip never touches the audio.
2. **Audio blobs are immutable and addressed by content hash.** New recordings are new blobs, never overwrites. Blobs referenced by any past version are never deleted.
3. **Stable segment IDs from day one.** Every segment keeps a permanent ID that survives text edits. Takes, comments and translations attach to that ID.
4. **Database as live state, Git as snapshots.** Edits go to MySQL. Git receives commits only at snapshot moments (manual "save version" or debounced autosave).
5. **Storage behind adapters.** `BlobStore` (put, get, stat, delete) and `VersionStore` (snapshot, list, readAt) are interfaces. The first implementations are server disk (`LocalDiskBlobStore`) and GitHub. Google Drive is a later `BlobStore`, not an assumption.
6. **The client never sees credentials.** All storage and GitHub access is configured and performed by the backend, using one central account.
7. **Heavy work stays outside the host.** Anything CPU-heavy or long-running (ffmpeg, TTS, speech-to-speech, LLM) sits behind a separate service interface, never inside the web app process.

## 4. Stack and hosting

The app runs on GoDaddy Node.js Hosting (a beta app platform with a Preview app and a Published app, not cPanel hosting; per GoDaddy's help pages and the container layout seen in the spike), using Node 22 with managed MySQL.

**Verified by the spike (2026-10-11 to 2026-10-13):** Node 22.23, deploy from GitHub, managed MySQL via `mysql2`, GitHub API commits through Octokit, and uploads up to 100 MiB per request. **Still unverified:** whether any file location is durable (see the disk findings below), websockets, scheduled jobs and backups. The spike code is gone, so durability is re-checked with the real `LocalDiskBlobStore` instead (see section 10).

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 22 + TypeScript | GoDaddy Node.js Hosting, deployed from a connected GitHub repo or an uploaded zip. The host sets the port (20010 seen in logs); the app reads `PORT`. Health check: the host calls `GET /` on `127.0.0.1:<port>` about once a second, and the deploy counts as unhealthy until it returns 200 |
| Server | Fastify | Thin API, stateless where possible |
| Database | Managed MySQL | Driver `mysql2`; Drizzle or Knex for queries and migrations; avoid ORMs with native binaries |
| Frontend | Static SPA (React or Svelte) | Built locally or in CI, served by the same app |
| Audio storage | Server disk behind `BlobStore` (`LocalDiskBlobStore`) | Root path must be configurable. Local disk was lost once in the spike; `/private` (shared network volume) is the candidate to prove durable. Google Drive is a later adapter |
| Text versions | GitHub REST API (Octokit) | Commits created through the API, no `git` binary on the server assumed |
| Secrets | Host Secrets settings, plus a local `.env` | The host injects `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and `DB_PASSWORD`. Names starting with `GITHUB_` are reserved (the host rejected `GITHUB_TOKEN`); use `SNAPSHOT_REPO_TOKEN` and `SNAPSHOT_REPO`. Never pasted into chats or committed |

**Two repos, two jobs.** The *code repo* deploys the app. The *snapshot repo* receives text versions at runtime. They must stay separate so snapshot commits never trigger a redeploy.

**Code layout.** A single package, not a monorepo: `src/server` (Fastify API), `src/web` (SPA, later) and `src/shared` (timeline types). ES modules with TypeScript `NodeNext` (imports in source carry the `.js` extension). `npm run build` compiles to `dist/`, and `npm start` runs `node dist/server/index.js`. **Observed on the host:** the Preview log shows the app started with `npm run dev` (`tsx watch src/server/index.ts`), not with build and start; whether Published does the same is unconfirmed. The port is read from the `PORT` environment variable. The spike routes (`/spike/*`) were removed on 2026-10-13 and are deliberately not in this repo's history, which starts from the cleaned state.

**Known limits to plan around**

- No SSH and no installable binaries (no ffmpeg on the server). Waveform peaks and compressed working copies are computed in the browser.
- Preview URLs require `?airoShareToken=...`; the Published URL does not (checked with curl, 2026-10-13).
- **Server disk (spike, 2026-10-13).** The app runs in a container whose root is read-only.
  - `/app` (including `public/assets`), `/local` (the home directory) and `/tmp` are on the node's local disk. Files there survived process restarts, source-only updates of Preview and a publish, but were **lost once** at an update whose cause is unknown (cause unknown; the one hypothesis, that a dependency change replaces the container, is not supported by the git history, which shows no dependency change in that window). Free space on that disk is the node's, not a quota, and shrinks as other tenants use it.
  - `/private` is a network (ceph) volume, writable, and **shared by Preview and Published**. Nothing else was visible in it. Its durability and quota are unverified: one marker written from Preview was visible from Published after a publish, and nothing more has been tested. The roughly 104 TB of free space it reports belongs to the volume, not to a quota for this app, and GoDaddy's help pages, as read in the spike, document no quotas or backups.
  - Preview and Published have separate local disks, but share MySQL (per the host's docs) and `/private`. The hostname was identical in both environments on every request where it was captured, so it cannot tell instances apart; the per-process boot ID changed at every restart.
  - No backup is documented by GoDaddy for files or the database. Preview apps are removed automatically after 30 days (GoDaddy FAQ).
  - GoDaddy documents `public/assets` as the folder for files that must persist between deployments; its behavior is not yet separated from the other local paths.
  - Until durability is proven, treat the disk as at risk. Durable state today is MySQL and GitHub; audio would be a single copy on the host.
- Websockets are unconfirmed, so v1 assumes plain request/response with save-on-change.
- Audio uploads go through the backend, so they need chunked or resumable uploads. Verified: bodies up to 100 MiB were accepted on both environments (about 19 s at 5 MiB/s from the owner's machine); larger sizes and longer times are untested. The 502 returned at 100 MiB plus 1 byte most likely came from our own route cap (the route destroys the connection above 100 MiB), so it does not show a host limit.
- Database backups depend on whether scheduled jobs exist. Unconfirmed.

## 5. Data model

The spine is User → Membership → Book → Chapter → Section → Timeline → Track → Clip → Segment, plus an Asset library per Book.

| Entity | Key fields | Notes |
| --- | --- | --- |
| User | id, login, display name | Central accounts |
| Membership | user, book, role | Roles: owner, author, narrator, translator. Built early to avoid a migration later |
| Book | id, title, visibility, language | Visibility defaults to private |
| Chapter, Section | id, book, order, title | Sections are the unit of one timeline |
| Segment | stable id, clip, order, text, optional file ID, trim in/out | The ID never changes when text is edited |
| Timeline | section, JSON document | Tracks and clips; live state in MySQL |
| Track | type: character, SFX or music; name | Character tracks link to a character |
| Clip | track, start, gain, ordered segments | Holds its segments; the segments reference takes, so moving a clip never touches audio |
| Take | asset, origin, created at | One recording or generated audio |
| Asset | id, book, type, name, hash, storage key, metadata | Single library model for audio, pictures and other files; the storage key is whatever the active `BlobStore` uses to find the file (a path under the book's folder on the server disk in v1, a Drive file ID in a later adapter) |

**Origin field.** Every Take carries an `origin`: `human-recorded`, `generated`, or `voice-converted` (a human performance converted to a character voice). It is unused in v1 but cheap to add now and keeps later claims honest.

**Version manifest.** A saved version is text plus timeline JSON plus a manifest mapping each asset to its hash. Restoring a version restores the manifest. Audio files themselves are never versioned, only referenced.

**Translations.** A translated segment stores the original's `segmentId` and a `sourceHash` of the original text it was translated from. The side-by-side view joins on the ID. If the original later changes, the hash no longer matches and the app flags the translation as out of date.

## 6. Storage, versioning and provenance

The version history exists to show that the text was written gradually, in small increments, by the author. Only text is proven, and v1 keeps it simple.

**Versioning rules**

- Snapshots are small and frequent: a manual "save version" plus autosave on a cadence (for example, every N minutes of active editing).
- The snapshot repo is public. Visibility is a per-book setting and defaults to private. Publishing a book's history publicly is an explicit action.
- History is append-only: force-push and branch deletion are disabled, and the app never rewrites history.
- Commits are created through the GitHub API (verified). Commit author and committer dates are set by the caller or defaulted by GitHub, so they prove nothing alone, and the commits are unsigned. GitHub's own record of the push or ref update is the independent timestamp; that has not been verified yet.
- Signed commits and an external timestamp (OpenTimestamps or an RFC 3161 authority) are planned additions, not v1.

**Repository layout.** The snapshot repo is organized per book, per chapter, per section:

```text
<book>/
    book.json            (chapter order, source language, list of translations)
    book.md              (generated: the whole book's script)
    <chapter>/
        chapter.json     (name, sections)
        <section>.json   (timeline: clips; each clip holds its segments)
        script.md        (generated: the chapter's script)
    translations/
        <lang>/
            book.md
            <chapter>/
                <section>.json
                script.md
```

- A section file holds that scene's timeline. Segments carry their text and an optional reference to a file ID, linked to the stored audio.
- `book.json` is the source of truth for structure. `book.md` and `script.md` are generated, carry an "auto-generated, do not edit" header, and are written at snapshot time only.
- Translations live in a separate language layer that mirrors the original structure, never inside the original segments. The original text history stays clean, each language can have its own timeline and takes, and a translator works without touching the source.

**What the proof can and cannot show.** A gradual trail shows a writing process. It does not prove that no AI was involved, because text could be pasted in small pieces. Later, typed-versus-pasted tracking and an edit-event log would strengthen it. The LLM feature is comment-only by default and does not write into the text, which keeps the trail clean.

**Central account trade-offs.** One central GitHub account (and later a central storage account) is simpler for users, but the operator carries the quota, cost and risk, and other authors' proof depends on trusting that account. In v1 the operator also carries the server's disk quota. Say so clearly in the product.

**Audio storage.** In v1, files live on the server's disk, behind `BlobStore`, in one folder per book, named by content hash. The app serves audio itself with HTTP range requests so seeking works, and Drive's latency and rate limits do not apply. On ingest, compute the hash and waveform peaks once (peaks in the browser). The storage root must be configurable and sit outside any folder that a deploy replaces. The spike found local disk lost once and `/private` shared between environments, so the root needs a per-environment prefix; see section 4.

**Backup risk.** Recordings are irreplaceable, and until a backup exists the server disk holds the only copy. Before real recordings go in, the project needs a backup or export routine (see open questions). A Drive `BlobStore` is one candidate, but not the only one.

## 7. Later extensions

Five extensions are planned after the MVP. Each must fit the existing model without reshaping it.

- **Translation view.** Original and translation shown side by side in the Redaction View, paired segment to segment. Translations live in their own language layer in the repo and are paired by the original segment's stable ID, with a source hash to flag outdated translations.
- **Integrated LLM.** A chat for discussing the text and leaving comments. Comment-only by default, so it never writes into the manuscript. Any LLM-inserted text would be flagged.
- **Speech generation.** Text-to-speech to generate speeches, or speech-to-speech that takes the author's own interpretation and replaces it with a character's voice. Current tools in use: Chatterbox (via Voicebox) for voice cloning and RVC (via Applio) for conversion. Free and open source is a hard constraint. This runs outside the web host, behind a service interface, and the output is a Take with the matching `origin`.
- **Audio compiler.** Renders a section's timeline into a single audio file. Needs ffmpeg or equivalent, so it also runs outside the web host.
- **Google Drive storage.** A `DriveBlobStore` behind `BlobStore`, one folder per book, via a central service account. Candidate uses are a backup target or an offload of the server disk. Points to settle first (not yet verified against current Google docs):
  - As far as we know, service accounts have no storage quota of their own, so uploads into a folder shared from a personal Google account can fail even though listing works.
  - A Shared Drive avoids this but may require Google Workspace.
  - Whether the owner's account is personal or Workspace decides the route.
  - The spike for this adapter must include a real upload, not only a folder listing.
  - Uploads could go from the browser straight to Drive with a short-lived token, but playback should not stream straight from Drive (latency, rate limits), so a server-side cache or compressed working copies would be needed.

## 8. Glossary

These terms are used consistently in code, UI and conversation.

| Term | Meaning |
| --- | --- |
| Redaction View | The main editing screen: text divided into chapters, sections and segments, each section shown as a timeline |
| Section | A part of a chapter; the unit that has one timeline |
| Segment | The smallest piece of text, with a permanent ID; lives inside a clip and may reference a take |
| Track | One layer of a timeline: a character's speech, a sound effect or music |
| Clip | A block placed on a track, with start and gain, that holds its segments |
| Take | One recording or generated audio file for a segment |
| Asset | Any file in a book's library |
| Library | The set of a book's assets, stored through `BlobStore` (server disk in v1) |
| Snapshot | A commit of text, timeline JSON and asset manifest to the snapshot repo |
| Manifest | A list mapping each asset to its content hash, saved with a version |
| BlobStore, VersionStore | Storage interfaces; server disk and GitHub are the first implementations, Drive comes later |
| Origin | How a take came to exist: human-recorded, generated or voice-converted |

## 9. Decision log

Decisions are listed newest first. Add a row whenever a decision changes; never delete old rows.

| Decision | Reason |
| --- | --- |
| Spike closed on 2026-10-13: `/spike/*` routes, `SPIKE_TOKEN` and `deploy.test` removed from the code repo. The remaining durability checks move to the first real `LocalDiskBlobStore` work, using a configurable root under `/private` | The spike answered the hosting questions it could; leaving token-guarded write routes in a deployed app is a standing risk, and the remaining checks are cheaper to run against the real adapter |
| Uploads are chunked and resumable from the start, a few MiB per request | A 100 MiB request took about 19 s from the owner's machine, a one-hour mono 48 kHz 24-bit WAV is about 0.5 GB, and the host's limit above 100 MiB is unknown |
| Local disk is not trusted as durable; the `LocalDiskBlobStore` root is configurable and namespaced per environment; `/private` is the candidate to prove durable before real audio is stored | Spike: local disk was lost once for an unknown reason, `/private` is a network volume shared by Preview and Published, and GoDaddy documents no backup |
| Snapshots are one commit per snapshot through the Git Data API (tree, commit, fast-forward ref update, never force) | Verified on the host; atomic and multi-file, unlike the Contents API which makes one commit per file |
| Snapshot repo settings use `SNAPSHOT_REPO_TOKEN` and `SNAPSHOT_REPO` | The host reserves `GITHUB_*` environment variable names |
| Spike routes (`/spike/*`) are token-guarded and removed after the spike | Public routes that write to the database, GitHub or storage are abusable |
| Audio and library files are stored on the server's disk in v1 behind `BlobStore` (`LocalDiskBlobStore`); Google Drive moves to a later extension. Supersedes the Drive part of "Central Drive and GitHub account" below | Removes Drive's service-account quota and Workspace question and Drive's playback latency from the MVP; the adapter keeps the choice reversible. Accepted risk: the disk is the only copy until a backup exists, and persistence across redeploys is unverified |
| Code repo is a single package (`src/server`, `src/web`, `src/shared`), Fastify, ES modules with `NodeNext`, port from `PORT` | Simplest deploy while the host's app root and build behavior are unknown; folders can be split later |
| MySQL from the app via `mysql2` with host-injected `DB_*` variables; short-lived connections per request | Verified on the host in the spike; the host's docs recommend this pattern |
| Segments live inside clips; a segment holds text and an optional file ID for its take | Matches the section file layout in the repo; the segment ID stays stable for takes, comments and translations |
| Translations in a separate language layer, mirroring the original structure and paired by segment ID plus source hash | Keeps the original text history clean for proof, allows a timeline per language, and flags translations when the original changes |
| Snapshot repo layout: book, chapter and section files, with generated book.md and script.md | Readable diffs and a structure the Redaction View maps onto directly; book.json is the source of truth for structure |
| Snapshots via GitHub REST API, no `git` binary; separate code and snapshot repos | No SSH on the host; snapshot commits must not trigger deploys |
| Runtime: GoDaddy Node.js Apps (Node 22), deployed from GitHub | Included in the plan; Node found under the hosting dashboard, not cPanel |
| Backend: Node.js + TypeScript, Fastify or Express | One language across client and server; shared types for the timeline model |
| Live state in managed MySQL, accessed with `mysql2` and Drizzle or Knex | Only MySQL is offered; pure-JS drivers avoid native builds |
| Provenance scope: text only, small frequent snapshots, append-only public repo, external timestamp later | Simplest version that proves incremental writing |
| Central Drive and GitHub account, behind swappable adapters | Simpler for users; the operator accepts cost and risk |
| Database holds live state; Git receives snapshots only | Fast editing and clean history without a commit per edit |
| Timeline stored as JSON referencing hashed, immutable audio | Non-destructive editing, diffable history |
| Stable segment IDs from day one | Takes, comments and translations attach to them |
| Roles (Membership table) modeled early | Avoids a painful migration when other authors join |

## 10. Open questions and spike

The hosting spike is closed (2026-10-13). Its findings are in section 4; the spike code itself is not kept in the repo.

**Spike:** a Fastify hello-world in TypeScript, deployed through the GitHub flow, that does three things.

1. Writes a row to MySQL. **Done 2026-10-11** (`GET /spike/db`, token-guarded).
2. Creates a commit in a test repo through the GitHub API. **Done 2026-10-13** (`GET /spike/github`: two files in one commit, fast-forward only).
3. Writes a file to the server disk, reads it back, and checks that it survives a restart and a redeploy. Also check the plan's disk quota and test an upload of a few MB for size and time limits. **Partly done 2026-10-13** (`/spike/disk/*`, since removed): results in section 4; the one-day check and the dependency-change test were not run and move to the `LocalDiskBlobStore` work.

The Drive spike (listing a folder and uploading a small file with a service account) moved to the Google Drive extension in section 7.

**Open questions**

- [ ] Does the host support websockets?
- [ ] What are the request size and time limits for uploads? Partly answered: up to 100 MiB accepted (about 19 s); larger and longer untested.
- [ ] Are cron or scheduled jobs available, so MySQL (and audio) can be backed up somewhere?
- [ ] What is the database size limit on this plan?
- [ ] What is the disk quota for files on this plan, and where can the app write files that survive redeploys? Partly answered: `/private` is writable and shared; durability and quota are unverified (one-day check pending).
- [ ] Backup strategy for audio on the server disk: what, where and how often, before real recordings go in.
- [ ] Frontend framework: React or Svelte?
- [ ] ORM choice: Drizzle or Knex?
- [ ] Autosave cadence for snapshots.
- [ ] Preview and Published share one database (per the host's docs) and `/private` (verified), but not local disk. How do we separate test data from real data, and how does the app tell which environment it is in?
- [ ] Connection pool allowed, or short-lived connections only?
- [ ] How does the host build `dist/`? Not visible in the deploy log. GoDaddy's FAQ says runtime packages must be in `dependencies`. The Preview log shows the host running `npm run dev` (`tsx watch`); the Published start command is unconfirmed.
- [ ] What wiped the local disk at the 2026-10-13 11:08 UTC update? The commit history shows no dependency change between the markers written and the loss, so the earlier hypothesis (a dependency change replaces the container) is not supported. Cause unknown.
- [ ] Does `/private` survive a Preview update, a redeploy and 24 hours? Write a marker before each step and check it afterwards.
- [ ] Dependency-change test: add or remove a dev dependency, update Preview, and check whether the local-disk and `/private` markers survive.
- [ ] Ask GoDaddy support: is `/private` persistent storage, what is its quota, and is it backed up?
- [ ] Spike cleanup, remaining host-side items (owner): drop the `spike_ping` table, delete the `audiobook-spike-data` marker folders (local disk, `public/assets`, `/private`), delete the `SPIKE_TOKEN` secret, and remove `spike/` from the snapshot repo. Code-side cleanup is done.
- [ ] Do the app's own File Manager and Database view allow export of files and of MySQL? (owner to check)
- [ ] Preview apps are removed after 30 days (GoDaddy FAQ). What happens to their database and `/private` files?
- [ ] Later (Drive extension): personal Google account or Workspace, and Shared Drive versus another quota and ownership model for the service account.

## 11. Working agreements

The owner is a former developer and project manager with 16 years of experience, so technical discussion can be peer-level. These rules apply to every chat in this Project.

- **Co-create, don't hand over.** Propose options with trade-offs and let the owner decide. Do not produce large complete drafts unasked.
- **Justify structural changes.** Any change to the data model, architecture or scope comes with a clear reason.
- **Honest engagement over validation.** Push back on weak decisions and name risks plainly, including on decisions already made.
- **Verify before asserting.** Hosting behavior, API limits and library details must be checked against current documentation; mark anything unverified as such.
- **Respect the constraints.** Free and open-source tooling, the current hosting plan, and the scope rules in sections 2 and 3.
- **Keep this Bible current.** When a chat produces a decision, propose a one-line decision-log entry and update the affected section.
- **One task per chat.** Specific chats handle specific tasks (for example, the spike, the timeline component, the storage adapter). Each starts from this Bible, and its outcome is fed back into it.
- **Where the work happens.** Planning and decisions happen in chats of this Project. Code changes happen in Claude Code, in the local clone of the code repo, with the owner's own git login. The canonical Bible lives in the code repo at `docs/PROJECT_BIBLE.md`, and the copy in the Project files is replaced whenever it changes.
- **Secrets.** Tokens, passwords and service-account files never go into chats or the repo. They live in the host's environment settings and in the local `.env`. GitHub tokens are fine-grained and limited to the one repo they need.
- **Language.** The owner writes mostly in Brazilian Portuguese but may switch to English. Reply in the language used; keep code, identifiers and this document in English.