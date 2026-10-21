import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, arrive, clampPos, nextMove, prevMove, where, type NavSegment, type Pos } from '../web/src/nav.ts';

// Two scenes: 4 s + 6 s of cues (a, b, then c), and a second segment, and a third.
const A: NavSegment = { id: 'A', scenes: [
  { id: 's1', startMs: 0, lengthMs: 10000, cues: [{ id: 'a', startMs: 0, lengthMs: 4000 }, { id: 'b', startMs: 4000, lengthMs: 6000 }] },
  { id: 's2', startMs: 10000, lengthMs: 5000, cues: [{ id: 'c', startMs: 0, lengthMs: 5000 }] },
] };
const B: NavSegment = { id: 'B', scenes: [{ id: 's3', startMs: 0, lengthMs: 2000, cues: [{ id: 'd', startMs: 0, lengthMs: 2000 }] }, { id: 's4', startMs: 2000, lengthMs: 0, cues: [] }] };
const order = ['A', 'B', 'C'];
const P = (segmentId: string, scene: number, ms: number): Pos => ({ segmentId, scene, ms });

test('previous cue: restart past 3 s, otherwise the previous cue', () => {
  assert.deepEqual(prevMove('cue', A, P('A', 0, 8000), order), { pos: P('A', 0, 4000) }); // 4 s into b
  assert.deepEqual(prevMove('cue', A, P('A', 0, 5000), order), { pos: P('A', 0, 0) });    // 1 s into b -> a
  assert.deepEqual(prevMove('cue', A, P('A', 1, 1000), order), { pos: P('A', 0, 4000) }); // first cue of scene 2 -> b
});

test('previous at the very beginning is unavailable, a little in it restarts', () => {
  assert.equal(prevMove('cue', A, P('A', 0, 0), order), null);
  assert.equal(prevMove('scene', A, P('A', 0, 0), order), null);
  assert.equal(prevMove('segment', A, P('A', 0, 0), order), null);
  assert.deepEqual(prevMove('cue', A, P('A', 0, 1000), order), { pos: P('A', 0, 0) });
  assert.deepEqual(prevMove('scene', A, P('A', 0, 2000), order), { pos: P('A', 0, 0) });
  assert.deepEqual(prevMove('segment', A, P('A', 0, 2000), order), { pos: P('A', 0, 0) });
});

test('previous scene and segment follow the 3 s rule', () => {
  assert.deepEqual(prevMove('scene', A, P('A', 1, 4000), order), { pos: P('A', 1, 0) });
  assert.deepEqual(prevMove('scene', A, P('A', 1, 1000), order), { pos: P('A', 0, 0) });
  assert.deepEqual(prevMove('segment', A, P('A', 1, 1000), order), { pos: P('A', 0, 0) }); // 11 s into the segment
});

test('moves across segments name the segment and where to land', () => {
  assert.deepEqual(prevMove('cue', B, P('B', 0, 1000), order), { segmentId: 'A', arrive: 'last-cue' });
  assert.deepEqual(prevMove('scene', B, P('B', 0, 1000), order), { segmentId: 'A', arrive: 'last-scene' });
  assert.deepEqual(prevMove('segment', B, P('B', 0, 1000), order), { segmentId: 'A', arrive: 'start' });
  assert.deepEqual(nextMove('cue', A, P('A', 1, 0), order), { segmentId: 'B', arrive: 'first-cue' });
  assert.deepEqual(nextMove('scene', A, P('A', 1, 0), order), { segmentId: 'B', arrive: 'start' });
  assert.deepEqual(nextMove('segment', A, P('A', 0, 0), order), { segmentId: 'B', arrive: 'start' });
});

test('next is unavailable at the very end', () => {
  const last = ['A'];
  assert.equal(nextMove('cue', A, P('A', 1, 0), last), null);
  assert.equal(nextMove('scene', A, P('A', 1, 0), last), null);
  assert.equal(nextMove('segment', A, P('A', 0, 0), last), null);
  assert.deepEqual(nextMove('cue', A, P('A', 0, 0), last), { pos: P('A', 0, 4000) });
  assert.deepEqual(nextMove('scene', A, P('A', 0, 9000), last), { pos: P('A', 1, 0) });
});

test('arriving in a segment', () => {
  assert.deepEqual(arrive(A, 'start'), P('A', 0, 0));
  assert.deepEqual(arrive(A, 'first-cue'), P('A', 0, 0));
  assert.deepEqual(arrive(A, 'last-cue'), P('A', 1, 0));
  assert.deepEqual(arrive(A, 'last-scene'), P('A', 1, 0));
  assert.deepEqual(arrive(B, 'last-scene'), P('B', 1, 0));
  const empty: NavSegment = { id: 'E', scenes: [{ id: 'x', startMs: 0, lengthMs: 0, cues: [] }] };
  assert.deepEqual(arrive(empty, 'last-cue'), P('E', 0, 0)); // no cues: the start
});

test('the clock walks scene to scene, into the next segment, and stops at the end', () => {
  assert.deepEqual(advance(A, P('A', 0, 0), 100, order), { pos: P('A', 0, 100) });
  assert.deepEqual(advance(A, P('A', 0, 9950), 100, order), { pos: P('A', 1, 50) }); // carries the remainder
  assert.deepEqual(advance(A, P('A', 1, 4950), 100, order), { move: { segmentId: 'B', arrive: 'start' } });
  assert.deepEqual(advance(A, P('A', 1, 4950), 100, ['A']), { end: P('A', 1, 5000) });
  // an empty scene is passed through at once
  assert.deepEqual(advance(B, P('B', 0, 1950), 100, order), { move: { segmentId: 'C', arrive: 'start' } });
});

test('positions are kept inside the segment after edits', () => {
  assert.deepEqual(clampPos(A, P('A', 5, 99999)), P('A', 1, 5000));
  assert.deepEqual(clampPos(A, P('A', 0, -5)), P('A', 0, 0));
});

test('readout numbers', () => {
  assert.deepEqual(where(A, P('A', 0, 5000)), { scene: 1, scenes: 2, cue: 2, cues: 2, sceneMs: 5000, sceneLengthMs: 10000 });
  assert.equal(where(B, P('B', 1, 0)).cues, 0);
});
