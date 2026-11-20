// Where an inserted or dropped cue starts (insertionPoint): after a long music bed it goes before the next cue.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { insertionPoint, type CueRow } from '../src/server/content.js';

const c = (id: string, startMs: number, lengthMs: number): CueRow => ({ id, startMs, lengthMs } as unknown as CueRow);

describe('insertion point', () => {
  it('starts where the cue above ends when the next cue starts later', () => {
    const cues = [c('a', 0, 4000), c('b', 6000, 3000)];
    assert.deepEqual(insertionPoint(cues, cues[0]), { startMs: 4000, keep: ['a'] });
  });
  it('after a long music bed, starts where the next cue starts (that one then moves on)', () => {
    const cues = [c('music', 0, 180_000), c('narrator', 10_000, 5000), c('sfx-later', 60_000, 2000)];
    assert.deepEqual(insertionPoint(cues, cues[0]), { startMs: 10_000, keep: ['music'] });
  });
  it('after the last cue, starts where it ends', () => {
    const cues = [c('music', 0, 180_000), c('narrator', 10_000, 5000)];
    assert.deepEqual(insertionPoint(cues, cues[1]), { startMs: 15_000, keep: ['music', 'narrator'] });
  });
  it('first in the scene starts at 0', () => {
    assert.deepEqual(insertionPoint([c('a', 0, 1000)], undefined), { startMs: 0, keep: [] });
  });
});
