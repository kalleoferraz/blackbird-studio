import { useState } from 'react';
import { api } from './api.ts';
import { LIBRARY_CHANGED } from './Library.tsx';
import type { Clip, Cue, SegmentContent } from './types.ts';
import { Dialog, errorText } from './ui.tsx';

/**
 * "Remove audio" on a cue: the chosen take comes off the cue, and the person says whether the file should also leave
 * the library (and the disk). The default is to keep it in the library.
 */
export function RemoveAudioDialog({ cue, onContent, onError, onClose }: {
  cue: Cue; onContent: (c: SegmentContent) => void; onError: (m: string) => void; onClose: () => void;
}) {
  const clip: Clip | undefined = cue.clips.find((k) => k.id === cue.clipId);
  const [busy, setBusy] = useState(false);
  if (!clip) return null;
  const go = async (fromLibrary: boolean) => {
    setBusy(true);
    try {
      const r = await api<SegmentContent & { assetDeleted?: boolean; assetKept?: string[] }>('DELETE', `/api/clips/${clip.id}${fromLibrary ? '?deleteAsset=1' : ''}`);
      onContent(r);
      onError(fromLibrary && r.assetKept ? `Removed from the cue. The file stays in the library because it is still used by ${r.assetKept.join(', ')}.` : '');
      if (fromLibrary) window.dispatchEvent(new Event(LIBRARY_CHANGED));
    } catch (e) { onError(errorText(e)); }
    onClose();
  };
  return (
    <Dialog title="Remove audio" onClose={onClose}>
      <p>Remove <strong>{clip.name}</strong> from this cue? You can also delete the file from the library, which removes it from the disk too.</p>
      <div className="row end">
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button className="danger solid" disabled={busy} onClick={() => void go(true)}>Remove from cue and library</button>
        <button className="primary" autoFocus disabled={busy} onClick={() => void go(false)}>Remove only from cue</button>
      </div>
    </Dialog>
  );
}
