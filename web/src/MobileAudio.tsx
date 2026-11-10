// On a phone there is no timeline: a cue's audio settings open in a panel above the player bar, the sliders on top, the volume envelope below.
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { SegmentContent } from './types.ts';
import { AudioSliders, ENVELOPE_NAME, type AudioEdit } from './AudioSettings.tsx';
import { ENVELOPE_KEY, EnvelopeEditor, Wave, laneColour } from './Timeline.tsx';
import { useNav, useStoreValue } from './playback.ts';
import { loadPeaks, type Peaks } from './peaks.ts';
import { errorText } from './ui.tsx';

const ENV_H = 96;

export function MobileAudioPanel({ content, edit, onEdit, onContent, onError, onClose }: {
  content: SegmentContent; edit: AudioEdit; onEdit: (e: AudioEdit) => void; onContent: (c: SegmentContent) => void; onError: (m: string) => void; onClose: () => void;
}) {
  const { cueId, kind } = edit;
  const cue = content.scenes.flatMap((s) => s.cues).find((c) => c.id === cueId);
  const clip = cue?.clips.find((k) => k.id === cue.clipId) ?? null;
  const nav = useNav();
  const store = nav?.store;
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!clip?.hasPeaks) return;
    let live = true;
    void loadPeaks(clip.assetId).then((p) => live && setPeaks(p));
    return () => { live = false; };
  }, [clip?.assetId, clip?.hasPeaks, clip?.status]);
  // The player bar's play starts at this cue, so each change can be heard at once (unless the playhead is already inside it).
  useEffect(() => {
    if (!store || !cue) return;
    const si = content.scenes.findIndex((s) => s.cues.some((c) => c.id === cueId));
    const inside = store.currentCueId() === cueId;
    if (si >= 0 && !inside) store.seek({ segmentId: content.segment.id, scene: si, ms: cue.startMs });
  }, [cueId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sceneId = content.scenes.find((s) => s.cues.some((c) => c.id === cueId))?.id ?? '';
  const at = useStoreValue(store, (s) => (s.pos && s.currentSceneId() === sceneId ? s.pos.ms : -1), -1);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  useEffect(() => { if (!cue || !clip) onClose(); }, [cue, clip]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(100, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [clip?.id]);
  if (!cue || !clip) return null;
  const run = async (method: string, url: string, body?: unknown) => {
    try { onContent(await api<SegmentContent>(method, url, body)); } catch (e) { onError(errorText(e)); }
  };
  return (
    <div className="m-audio-panel">
      <div className="ma-head"><b>Audio settings</b><button className="ma-done" onClick={onClose}>Done</button></div>
      <AudioSliders clip={clip} run={(m, u, b) => void run(m, u, b)} env={kind} onEnv={(k) => onEdit({ cueId, kind: k })} />
      <div className="ma-label">{ENVELOPE_NAME[kind]} envelope</div>
      <div className="ma-env" ref={box} style={{ height: ENV_H }}>
        {peaks && <Wave peaks={peaks} offsetMs={clip.offsetMs} clipMs={clip.lengthMs} lengthMs={Math.max(1, cue.lengthMs)} width={w} height={ENV_H}
          colour={laneColour(content.lanes.find((l) => l.id === cue.laneId)?.colour ?? '#EDE4DC')} speed={clip.speed} speedPoints={clip.speedPoints} />}
        {cue && at >= cue.startMs && at <= cue.startMs + cue.lengthMs && <div className="ma-playhead" style={{ left: Math.max(0, Math.min(w, ((at - cue.startMs) / Math.max(1, cue.lengthMs)) * w)) }} />}
        <EnvelopeEditor key={kind} kind={kind} points={clip[ENVELOPE_KEY[kind]]} lengthMs={Math.max(1, cue.lengthMs)} width={w} height={ENV_H}
          onSeek={(ms) => { const si = content.scenes.findIndex((s) => s.cues.some((c) => c.id === cueId)); if (si >= 0) store?.seek({ segmentId: content.segment.id, scene: si, ms: Math.round(cue.startMs + ms) }); }}
          onChange={(points) => void run('PATCH', `/api/clips/${clip.id}`, { [ENVELOPE_KEY[kind]]: points })} />
      </div>
      <p className="muted small">Double-tap to add a point, drag a point to move it, double-tap a point to remove it. A tap moves the playhead.</p>
    </div>
  );
}
