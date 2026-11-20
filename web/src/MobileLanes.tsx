// On a phone held upright there is no room for the timeline: its button opens this panel above the player bar instead,
// with one level slider per lane of the segment (Bible, decision log 2026-11-20: lane levels). Turned sideways, the phone shows the timeline.
import { api } from './api.ts';
import type { SegmentContent } from './types.ts';
import { LaneLevelRow, laneColour, laneGains } from './Timeline.tsx';
import { errorText } from './ui.tsx';

export function MobileLanesPanel({ content, readOnly, onContent, onError, onClose }: {
  content: SegmentContent; readOnly: boolean; onContent: (c: SegmentContent) => void; onError: (m: string) => void; onClose: () => void;
}) {
  const used = new Set(content.scenes.flatMap((s) => s.cues).map((c) => c.laneId));
  const lanes = content.lanes.filter((l) => used.has(l.id));
  const run = async (method: string, url: string, body?: unknown) => {
    try { onContent(await api<SegmentContent>(method, url, body)); } catch (e) { onError(errorText(e)); }
  };
  return (
    <div className="m-audio-panel m-lanes" data-testid="mobile-lanes">
      <div className="ma-head"><b>Lane levels</b><button className="ma-done" onClick={onClose}>Done</button></div>
      {lanes.length === 0 && <p className="muted small">No lanes in this segment yet.</p>}
      <div className="as-sliders">
        {lanes.map((l) => {
          const n = laneGains(content, l.id).length;
          return <LaneLevelRow key={l.id} lane={l} content={content} readOnly={readOnly} run={(m, u, b) => void run(m, u, b)}
            label={<span className="ml-name" title={n ? `${l.title} · ${n} take${n === 1 ? '' : 's'}` : `${l.title} · no takes yet`}><i style={{ background: laneColour(l.colour) }} />{l.title}</span>} />;
        })}
      </div>
      <p className="muted small">{readOnly ? 'View only.' : 'Each slider moves every take on its lane by the same amount. Turn the phone sideways for the timeline.'}</p>
    </div>
  );
}
