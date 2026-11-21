// Lets a panel outside the script hand over new segment content (a take kept from the Voice panel, say).
import { createContext } from 'react';
import type { SegmentContent } from './types.ts';

export const ContentSink = createContext<((c: SegmentContent) => void) | null>(null);
