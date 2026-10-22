/**
 * Blackbird Script Studio: Drizzle schema (MySQL).
 *
 * Mirrors the "Physical schema" section of docs/PROJECT_BIBLE.md. The key types, collations and
 * delete rules were checked on the host's database in the 2026-10-15 spike (see the Bible); the
 * migration itself has not been applied there yet.
 *
 * Conventions
 * - Ids are app-generated ULIDs: CHAR(26) ascii_bin, same type on every foreign key column.
 * - Text uses the database default collation. Where case-insensitive uniqueness matters
 *   (user.email, asset.path, note.ref_key) the column states utf8mb4_unicode_ci itself.
 *   Create the database with DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci.
 * - Times are integer milliseconds; timestamps are DATETIME(3) in UTC, set by the app.
 * - Closed sets are ENUMs; adding a value is an additive migration.
 * - Rules the database cannot express (cue overlap on a lane, a cue's lane and scene sharing a segment,
 *   asset immutability, reply rules for notes, one reference per ref key) are enforced by the app.
 */
import {
  bigint,
  double,
  boolean,
  customType,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  tinyint,
  uniqueIndex,
  varchar,
  type AnyMySqlColumn,
} from 'drizzle-orm/mysql-core';

// ---- column helpers -------------------------------------------------------

/** ULID: CHAR(26), ASCII, binary collation (case-sensitive, compact, readable in the host's database view). */
const ulid = customType<{ data: string }>({
  dataType: () => 'char(26) character set ascii collate ascii_bin',
});

/** Fixed-length ASCII text, case-sensitive (hashes, commit SHAs, colours). */
const asciiChar = customType<{ data: string; config: { length: number } }>({
  dataType: (config) => `char(${config?.length ?? 1}) character set ascii collate ascii_bin`,
});

const asciiVarchar = customType<{ data: string; config: { length: number } }>({
  dataType: (config) => `varchar(${config?.length ?? 64}) character set ascii collate ascii_bin`,
});

/** Case-insensitive, accent-insensitive text (utf8mb4_unicode_ci), for columns that carry a uniqueness rule. */
const ciVarchar = customType<{ data: string; config: { length: number } }>({
  dataType: (config) =>
    `varchar(${config?.length ?? 255}) character set utf8mb4 collate utf8mb4_unicode_ci`,
});

const ts = (name: string) => datetime(name, { mode: 'date', fsp: 3 });
const createdAt = () => ts('created_at').notNull();
const updatedAt = () => ts('updated_at').notNull();

const mediumBlob = customType<{ data: Buffer }>({
  dataType: () => 'mediumblob',
});

const ms = (name: string) => int(name, { unsigned: true });
const position = () => smallint('position', { unsigned: true }).notNull();

// ---- accounts -------------------------------------------------------------

export const user = mysqlTable(
  'user',
  {
    id: ulid('id').primaryKey(),
    email: ciVarchar('email', { length: 254 }).notNull(), // stored lowercase
    passwordHash: varchar('password_hash', { length: 255 }).notNull(), // scrypt string with its parameters
    displayName: varchar('display_name', { length: 100 }).notNull(),
    disabledAt: ts('disabled_at'), // set: the user cannot log in and every session cookie stops working
    mustChangePassword: boolean('must_change_password').notNull().default(false), // set after a temporary password
  lastLoginAt: ts('last_login_at'),
  lastEditAt: ts('last_edit_at'), // set by the touch helper for the acting user
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_email_uq').on(t.email)],
);

export const team = mysqlTable(
  'team',
  {
    id: ulid('id').primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('team_name_uq').on(t.name)],
);

export const teamMember = mysqlTable(
  'team_member',
  {
    teamId: ulid('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: ulid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('team_member_user_idx').on(t.userId)],
);

// ---- project ----------------------------------------------------------------

export const project = mysqlTable('project', {
  id: ulid('id').primaryKey(),
  type: mysqlEnum('type', ['audiobook', 'textbook', 'film', 'series', 'podcast']).notNull().default('audiobook'),
  title: varchar('title', { length: 200 }).notNull(),
  subtitle: varchar('subtitle', { length: 200 }),
  language: varchar('language', { length: 10 }).notNull(), // BCP 47, such as pt-BR
  // What the recorded speech takes taught the speech-length estimate: speaking units and the milliseconds they took (see src/shared/estimate.ts).
  speechUnits: double('speech_units').notNull().default(0),
  speechMs: bigint('speech_ms', { mode: 'number', unsigned: true }).notNull().default(0),
  // Cyclic with asset: the constraint is emitted as a separate ALTER TABLE by drizzle-kit.
  coverAssetId: ulid('cover_asset_id').references((): AnyMySqlColumn => asset.id, {
    onDelete: 'set null',
  }),
  // Increased by the touch helper on every write; a push clears dirtySince only if the revision is unchanged.
  revision: bigint('revision', { mode: 'number', unsigned: true }).notNull().default(0),
  dirtySince: ts('dirty_since'),
  lastEditedAt: ts('last_edited_at'), // set by the touch helper on every write that ends up in a snapshot
  activeSession: ulid('active_session'),
  // Folder name in the snapshot repo: suggested from the title at creation, unique ignoring case, not changed by title edits.
  repoFolder: ciVarchar('repo_folder', { length: 80 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('project_repo_folder_uq').on(t.repoFolder)]);

export const membership = mysqlTable(
  'membership',
  {
    userId: ulid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    projectId: ulid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    // One role per membership for now; several roles later means a user_roles table.
    role: mysqlEnum('role', ['author', 'narrator', 'translator', 'reader']).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    index('membership_project_idx').on(t.projectId),
  ],
);

// ---- library ----------------------------------------------------------------

export const asset = mysqlTable(
  'asset',
  {
    id: ulid('id').primaryKey(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    path: ciVarchar('path', { length: 255 }).notNull(),
    hash: asciiChar('hash', { length: 64 }).notNull(), // SHA-256 of the audio samples (bytes for other files), lowercase hex
    mediaKind: mysqlEnum('media_kind', ['audio', 'image', 'video', 'document', 'other']).notNull(),
    size: bigint('size', { mode: 'number', unsigned: true }).notNull(),
    sizeLightweight: bigint('size_lightweight', { mode: 'number', unsigned: true }), // null: no lightweight copy
    lightweightPath: ciVarchar('lightweight_path', { length: 255 }), // the derived copy (MP3 of a WAV, reduced image)
    mediaInfo: json('media_info'), // duration, sample rate, channels, bit depth, ...
    // The state of the encoding and peaks work, claimed by a worker with a conditional UPDATE.
    status: mysqlEnum('status', ['pending', 'processing', 'ready', 'failed'])
      .notNull()
      .default('pending'),
    // The reconciler's result: drives the red (missing) and amber (changed) icons.
    fileState: mysqlEnum('file_state', ['ok', 'missing', 'changed']).notNull().default('ok'),
    claimedBy: varchar('claimed_by', { length: 64 }),
    claimedAt: ts('claimed_at'),
    attempts: tinyint('attempts', { unsigned: true }).notNull().default(0),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('asset_project_hash_uq').on(t.projectId, t.hash),
    uniqueIndex('asset_project_path_uq').on(t.projectId, t.path),
    uniqueIndex('asset_project_lightweight_path_uq').on(t.projectId, t.lightweightPath), // several NULLs allowed
    index('asset_status_claimed_idx').on(t.status, t.claimedAt),
  ],
);

/**
 * Waveform peaks of an audio asset: one byte per `step_ms` (100), the loudest sample of the window on a decibel
 * scale (0 = -60 dB or silence, 255 = full scale). Written once when the asset is ready, so the library listing
 * never carries it. See src/audio/peaks.ts.
 */
export const assetPeaks = mysqlTable('asset_peaks', {
  assetId: ulid('asset_id')
    .primaryKey()
    .references(() => asset.id, { onDelete: 'cascade' }),
  stepMs: smallint('step_ms', { unsigned: true }).notNull().default(100),
  data: mediumBlob('data').notNull(),
  createdAt: createdAt(),
});

export const character = mysqlTable(
  'character',
  {
    id: ulid('id').primaryKey(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    isNarrator: boolean('is_narrator').notNull().default(false), // the Narrator of the media project; cannot be removed
    defaultColour: asciiChar('default_colour', { length: 7 }).notNull(), // #rrggbb
    pictureAssetId: ulid('picture_asset_id').references(() => asset.id, { onDelete: 'restrict' }),
    description: text('description'),
    folder: varchar('folder', { length: 30 }).notNull(), // sanitized folder name under Characters/, a number added on collision
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('character_project_folder_uq').on(t.projectId, t.folder)],
);

// ---- the tree: chapter > segment > scene / lane > cue > clip -------------------

export const chapter = mysqlTable(
  'chapter',
  {
    id: ulid('id').primaryKey(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    // 1..n across all chapters; introductory chapters come first (enforced by the app).
    position: position(),
    title: varchar('title', { length: 200 }).notNull(),
    introductory: boolean('introductory').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('chapter_project_position_uq').on(t.projectId, t.position)],
);

export const segment = mysqlTable(
  'segment',
  {
    id: ulid('id').primaryKey(),
    chapterId: ulid('chapter_id')
      .notNull()
      .references(() => chapter.id, { onDelete: 'cascade' }),
    position: position(),
    title: varchar('title', { length: 200 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('segment_chapter_position_uq').on(t.chapterId, t.position)],
);

export const scene = mysqlTable(
  'scene',
  {
    id: ulid('id').primaryKey(),
    segmentId: ulid('segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    position: position(),
    label: varchar('label', { length: 100 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('scene_segment_position_uq').on(t.segmentId, t.position)],
);

export const lane = mysqlTable(
  'lane',
  {
    id: ulid('id').primaryKey(),
    segmentId: ulid('segment_id')
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    characterId: ulid('character_id').references(() => character.id, { onDelete: 'restrict' }),
    position: position(),
    title: varchar('title', { length: 100 }).notNull(),
    colour: asciiChar('colour', { length: 7 }).notNull(), // #rrggbb, copied from the character when linked
    auto: boolean('auto').notNull().default(true), // created by the app from cues; deleted when empty; a renamed or recoloured lane stops being automatic (proposed)
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('lane_segment_position_uq').on(t.segmentId, t.position)],
);

export const cue = mysqlTable(
  'cue',
  {
    id: ulid('id').primaryKey(),
    sceneId: ulid('scene_id')
      .notNull()
      .references(() => scene.id, { onDelete: 'cascade' }),
    laneId: ulid('lane_id')
      .notNull()
      .references(() => lane.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', ['speech', 'sfx', 'music']).notNull().default('speech'),
    // The speaker: null means none or, for a speech cue with a Narrator character, see the Bible. Lanes follow from it.
    characterId: ulid('character_id').references(() => character.id, { onDelete: 'restrict' }),
    // The chosen clip. Cyclic with clip; the constraint becomes a separate ALTER TABLE.
    clipId: ulid('clip_id').references((): AnyMySqlColumn => clip.id, { onDelete: 'set null' }),
    startMs: ms('start_ms').notNull(), // relative to the scene
    lengthMs: ms('length_ms').notNull(), // authoritative: a clip plays inside it
    // True until the length is set by hand or a clip becomes chosen. Speech: follows the text estimate; sfx and music: follows the chosen clip's audio length.
    lengthAuto: boolean('length_auto').notNull().default(true),
    textMd: text('text_md').notNull(), // speech: Markdown spoken text; sfx and music: a one-line description
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('cue_scene_start_idx').on(t.sceneId, t.startMs),
    index('cue_lane_scene_start_idx').on(t.laneId, t.sceneId, t.startMs),
    index('cue_clip_idx').on(t.clipId),
  ],
);

export const clip = mysqlTable(
  'clip',
  {
    id: ulid('id').primaryKey(),
    cueId: ulid('cue_id')
      .notNull()
      .references((): AnyMySqlColumn => cue.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id')
      .notNull()
      .references(() => asset.id, { onDelete: 'restrict' }),
    number: smallint('number', { unsigned: true }).notNull(), // the take number, the "(n)" in file names
    offsetMs: ms('offset_ms').notNull(),
    lengthMs: ms('length_ms').notNull(),
    gainDb: decimal('gain_db', { precision: 5, scale: 2 }).notNull().default('0.00'),
    fadeInMs: ms('fade_in_ms').notNull().default(100), // 100 ms: enough to avoid clicks; editable later
    fadeOutMs: ms('fade_out_ms').notNull().default(100),
    // `loop` is a reserved word in MySQL. 0 plays once, N plays N + 1 times, -1 repeats until the cue ends.
    loops: smallint('loops').notNull().default(0),
    origin: mysqlEnum('origin', ['human-recorded', 'generated', 'voice-converted']).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('clip_cue_number_uq').on(t.cueId, t.number),
    index('clip_asset_idx').on(t.assetId),
  ],
);

// ---- notes: comment | reference | task, on any level, flat threads ---------------

export const note = mysqlTable(
  'note',
  {
    id: ulid('id').primaryKey(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    authorUserId: ulid('author_user_id').references(() => user.id, { onDelete: 'set null' }), // null: the account is gone (kind user), or the note is by the system or the LLM
    authorKind: mysqlEnum('author_kind', ['user', 'system', 'llm']).notNull().default('user'),
    type: mysqlEnum('type', ['comment', 'reference', 'task']).notNull(),
    textMd: text('text_md').notNull(),
    refKey: ciVarchar('ref_key', { length: 24 }), // references only: required, unique per project, also the sort key
    link: varchar('link', { length: 2048 }), // references only: an http or https URL, checked by the app
    doneAt: ts('done_at'), // tasks only
    doneByUserId: ulid('done_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    // A root note has no other target (the project itself) or exactly one of these (checked by the app).
    chapterId: ulid('chapter_id').references(() => chapter.id, { onDelete: 'cascade' }),
    segmentId: ulid('segment_id').references(() => segment.id, { onDelete: 'cascade' }),
    sceneId: ulid('scene_id').references(() => scene.id, { onDelete: 'cascade' }),
    cueId: ulid('cue_id').references(() => cue.id, { onDelete: 'cascade' }),
    assetId: ulid('asset_id').references(() => asset.id, { onDelete: 'cascade' }),
    // A reply is always a comment. It points at its root note (one cascade level) and may name the note it answers.
    rootNoteId: ulid('root_note_id').references((): AnyMySqlColumn => note.id, {
      onDelete: 'cascade',
    }),
    replyToNoteId: ulid('reply_to_note_id').references((): AnyMySqlColumn => note.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'), // tombstone: a note with replies keeps its row, text and ref key cleared
  },
  (t) => [
    index('note_project_type_idx').on(t.projectId, t.type),
    uniqueIndex('note_project_ref_key_uq').on(t.projectId, t.refKey), // several NULLs are allowed
    index('note_chapter_idx').on(t.chapterId),
    index('note_segment_idx').on(t.segmentId),
    index('note_scene_idx').on(t.sceneId),
    index('note_cue_idx').on(t.cueId),
    index('note_asset_idx').on(t.assetId),
    index('note_root_created_idx').on(t.rootNoteId, t.createdAt),
    index('note_reply_to_idx').on(t.replyToNoteId),
  ],
);

// ---- versions ----------------------------------------------------------------

export const snapshot = mysqlTable(
  'snapshot',
  {
    id: ulid('id').primaryKey(),
    projectId: ulid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    commitSha: asciiVarchar('commit_sha', { length: 64 }).notNull(),
    revision: bigint('revision', { mode: 'number', unsigned: true }).notNull(), // the project revision this snapshot captured
    label: varchar('label', { length: 200 }),
    createdByUserId: ulid('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('snapshot_project_created_idx').on(t.projectId, t.createdAt)],
);
