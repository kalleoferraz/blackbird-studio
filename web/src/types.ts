export interface Me {
  user: { id: string; email: string; displayName: string; isAdmin: boolean; mustChangePassword: boolean };
}

export interface ProjectCard {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  language: string;
  role: 'author' | 'viewer';
  createdAt: string;
  lastEditedAt: string | null;
  dirtySince: string | null;
  lastSnapshotAt: string | null;
  chapterCount: number;
  sizeBytes: number;
  commentCount: number;
  referenceCount: number;
  openTaskCount: number;
  repoFolder: string | null;
  coverAssetId: string | null;
}

export interface Language { code: string; label: string; name: string; flag: string }

export interface StorySegment { id: string; position: number; title: string; cueCount: number }
export interface StoryChapter { id: string; position: number; index: string; title: string; introductory: boolean; segments: StorySegment[] }
export interface Story { chapters: StoryChapter[]; created?: string }

export type CueType = 'speech' | 'sfx' | 'music';
export interface Clip {
  id: string; cueId: string; number: number; assetId: string; name: string;
  offsetMs: number; lengthMs: number; gainDb: number; fadeInMs: number; fadeOutMs: number; loops: number;
  /** Audio settings: speed (pitch kept), pitch in cents (speed kept) and the volume envelope [ms, dB]. lengthMs is the playing time; the piece of the file is lengthMs * speed. */
  speed: number; pitchCents: number; volumePoints: [number, number][] | null; speedPoints: [number, number][] | null; pitchPoints: [number, number][] | null;
  origin: 'human-recorded' | 'generated' | 'voice-converted';
  assetDurationMs: number | null; status: 'pending' | 'processing' | 'ready' | 'failed'; hasPeaks: boolean; light: boolean; fileMissing: boolean;
}
export interface Cue {
  id: string; laneId: string; type: CueType; characterId: string | null;
  startMs: number; lengthMs: number; lengthAuto: boolean; muted: boolean; text: string; clipId: string | null; clips: Clip[];
}
export interface Scene { id: string; position: number; label: string | null; startMs: number; lengthMs: number; cues: Cue[] }
export interface Lane { id: string; title: string; colour: string; characterId: string | null; position: number; auto: boolean }
export interface SegmentContent {
  segment: { id: string; title: string; chapterId: string; chapterTitle: string; projectId: string };
  project: { id: string; type: string; language: string };
  scenes: Scene[];
  lanes: Lane[];
  created?: string;
}

export interface Character {
  id: string; name: string; isNarrator: boolean; colour: string; description: string | null;
  folder: string | null; pictureAssetId: string | null; cueCount?: number;
  /** The ElevenLabs voice (Bible, decision log 2026-11-20). */
  voice?: { id: string; name: string; source: 'account' | 'public' | 'clone' | null } | null;
  /** "Voice Settings": directions added to every generation as audio tags. */
  voiceDirection?: string | null;
  voiceSettings?: VoiceSettings | null;
}
export interface VoiceSettings { stability?: number | null; similarity?: number | null; style?: number | null; speed?: number | null; speakerBoost?: boolean | null }
export interface Member { userId: string; name: string; email: string; role: 'author' | 'viewer'; addedAt: string }

export interface LibFolder { name: string; path: string; managed: boolean; writable: boolean }
export interface LibFile {
  id: string; name: string; path: string; kind: 'audio' | 'image' | 'video' | 'document' | 'other';
  size: number; sizeLightweight: number | null; hasLightweight: boolean; width: number | null; height: number | null;
  status: 'pending' | 'processing' | 'ready' | 'failed'; hasPeaks: boolean; error: string | null;
  format: string | null; durationMs: number | null; sampleRate: number | null; channels: number | null;
  fileState: 'ok' | 'missing' | 'changed'; earlierCover: boolean; createdAt: string; usage?: string[];
}
export interface LibListing { folder: string; canEdit: boolean; writable: boolean; folders: LibFolder[]; files: LibFile[] }

export type NoteType = 'comment' | 'task' | 'reference';
export type NoteTargetKind = 'chapter' | 'segment' | 'scene' | 'cue' | 'asset';
export interface NotePlace {
  chapterId: string | null; segmentId: string | null; sceneId: string | null; cueId: string | null; assetId: string | null;
  label: string | null; sceneNo: number | null; cueStartMs: number | null;
}
export interface NoteItem {
  id: string; type: NoteType; textMd: string; refKey: string | null; link: string | null;
  authorKind: 'user' | 'system' | 'llm'; author: { id: string; name: string } | null;
  doneAt: string | null; doneBy: { id: string; name: string } | null;
  target: { kind: NoteTargetKind; id: string } | null; place: NotePlace;
  rootNoteId: string | null; replyToNoteId: string | null; createdAt: string; editedAt: string | null; deleted: boolean;
}
/** Where the reader is in the script: the Notes panel opens and highlights this path. */
export interface NoteFocus {
  chapterId: string | null; segmentId: string | null; sceneId: string | null; sceneNo: number | null;
  cueId: string | null; cueLabel: string | null;
}
/** A request to show one place in the Notes panel (from a cue's notes icon or a Library badge). */
export interface NoteRequest {
  n: number; chapterId?: string | null; segmentId?: string | null; sceneId?: string | null; cueId?: string | null; assetId?: string | null;
}
