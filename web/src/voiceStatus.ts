// Whether the voice options are on (an ElevenLabs key is set in the admin area), asked once per page load.
import { useEffect, useState } from 'react';
import { api } from './api.ts';

export interface VoiceStatus { enabled: boolean; reason?: string }

let cached: Promise<VoiceStatus> | null = null;
export const voiceStatus = () => (cached ??= api<VoiceStatus>('GET', '/api/voices/status').catch(() => ({ enabled: false, reason: 'The voice settings could not be read.' })));

export function useVoiceStatus(): VoiceStatus | null {
  const [s, setS] = useState<VoiceStatus | null>(null);
  useEffect(() => { let on = true; void voiceStatus().then((v) => { if (on) setS(v); }); return () => { on = false; }; }, []);
  return s;
}
