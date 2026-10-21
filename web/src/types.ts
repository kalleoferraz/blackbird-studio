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
  origin: 'human-recorded' | 'generated' | 'voice-converted';
  assetDurationMs: number | null; status: 'pending' | 'processing' | 'ready' | 'failed'; hasPeaks: boolean;
}
export interface Cue {
  id: string; laneId: string; type: CueType; characterId: string | null;
  startMs: number; lengthMs: number; lengthAuto: boolean; text: string; clipId: string | null; clips: Clip[];
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
}
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
