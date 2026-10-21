/**
 * The ripple rule (Bible, section 5, Lane rules): when a cue's length changes, every cue of the scene
 * that starts at or after the changed cue's old end moves by the change, so gaps are kept; cues that start
 * earlier stay. The lane rule wins: a moved cue never overlaps a cue on its own lane that stayed.
 */
export interface RippleCue {
  id: string;
  laneId: string;
  startMs: number;
  lengthMs: number;
}

/**
 * `cues` is the state after the change: the changed cue already has its new length.
 * Returns the new start of every cue that moves (cues that stay are not in the result).
 * `oldEndMs` is where the changed cue used to end (or, for an insert, where the new cue starts),
 * `delta` is the change in milliseconds (negative when something shrinks or is removed).
 * `excludeIds` are the cues that are the subject of the change and must not be moved.
 */
export function ripple(
  cues: readonly RippleCue[],
  oldEndMs: number,
  delta: number,
  excludeIds: readonly string[] = [],
): Map<string, number> {
  const result = new Map<string, number>();
  if (delta === 0) return result;
  const excluded = new Set(excludeIds);
  const moving = cues.filter((c) => !excluded.has(c.id) && c.startMs >= oldEndMs).sort((a, b) => a.startMs - b.startMs);
  const movingIds = new Set(moving.map((c) => c.id));
  // The end of the latest cue that stays, per lane: a shrinking ripple stops against it.
  const stayEnd = new Map<string, number>();
  for (const c of cues) {
    if (movingIds.has(c.id)) continue;
    stayEnd.set(c.laneId, Math.max(stayEnd.get(c.laneId) ?? 0, c.startMs + c.lengthMs));
  }
  const laneEnd = new Map<string, number>();
  for (const c of moving) {
    let start = Math.max(0, c.startMs + delta);
    if (delta < 0) {
      const floor = Math.max(stayEnd.get(c.laneId) ?? 0, laneEnd.get(c.laneId) ?? 0);
      if (start < floor) start = floor;
    }
    laneEnd.set(c.laneId, start + c.lengthMs);
    if (start !== c.startMs) result.set(c.id, start);
  }
  return result;
}
