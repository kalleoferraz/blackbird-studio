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
}

export interface Language { code: string; label: string; name: string; flag: string }

export interface StoryScene { id: string; position: number; title: string; cueCount: number }
export interface StoryChapter { id: string; position: number; index: string; title: string; introductory: boolean; scenes: StoryScene[] }
export interface Story { chapters: StoryChapter[]; created?: string }

export type CueType = 'speech' | 'sfx' | 'music';
export interface Cue {
  id: string; laneId: string; type: CueType; characterId: string | null;
  startMs: number; lengthMs: number; lengthAuto: boolean; text: string; clipId: string | null;
}
export interface Segment { id: string; position: number; label: string | null; startMs: number; lengthMs: number; cues: Cue[] }
export interface Lane { id: string; title: string; colour: string; characterId: string | null; position: number; auto: boolean }
export interface SceneContent {
  scene: { id: string; title: string; chapterId: string; chapterTitle: string; projectId: string };
  project: { id: string; type: string; language: string };
  segments: Segment[];
  lanes: Lane[];
  created?: string;
}

export interface Character {
  id: string; name: string; isNarrator: boolean; colour: string; description: string | null;
  folder: string | null; pictureAssetId: string | null; cueCount?: number;
}
export interface Member { userId: string; name: string; email: string; role: 'author' | 'viewer'; addedAt: string }
