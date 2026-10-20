import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ripple } from '../src/shared/ripple.js';
import { estimateSpeechMs } from '../src/shared/estimate.js';

test('ripple moves later cues by the change and keeps gaps', () => {
  const cues = [
    { id: 'a', laneId: 'L1', startMs: 0, lengthMs: 3000 }, // already grown from 1000
    { id: 'b', laneId: 'L1', startMs: 1500, lengthMs: 1000 },
    { id: 'c', laneId: 'L2', startMs: 3000, lengthMs: 500 },
  ];
  const moved = ripple(cues, 1000, 2000, ['a']);
  assert.equal(moved.get('b'), 3500);
  assert.equal(moved.get('c'), 5000);
});

test('ripple leaves cues that start earlier', () => {
  const cues = [
    { id: 'a', laneId: 'L1', startMs: 0, lengthMs: 2000 }, // already shrunk from 3000
    { id: 'x', laneId: 'L2', startMs: 500, lengthMs: 4000 },
    { id: 'b', laneId: 'L1', startMs: 3000, lengthMs: 1000 },
  ];
  const moved = ripple(cues, 3000, -1000, ['a']);
  assert.equal(moved.has('x'), false);
  // b would move to 2000, but x on another lane is not on its lane, so it moves freely
  assert.equal(moved.get('b'), 2000);
});

test('a shrinking ripple stops against a cue on its lane that stayed', () => {
  const cues = [
    { id: 'a', laneId: 'L1', startMs: 0, lengthMs: 1000 }, // already shrunk from 3000
    { id: 'x', laneId: 'L2', startMs: 1000, lengthMs: 3500 }, // stays (starts before old end), ends at 4500
    { id: 'y', laneId: 'L2', startMs: 5000, lengthMs: 500 },
  ];
  const moved = ripple(cues, 3000, -2000, ['a']);
  assert.equal(moved.get('y'), 4500);
});

test('speech estimate has a floor and grows with text', () => {
  assert.equal(estimateSpeechMs('', 'en-US'), 1000);
  assert.ok(estimateSpeechMs('Hello there, how are you doing today?', 'en-US') > 1000);
  assert.ok(estimateSpeechMs('**Hello** there\n\nSecond line', 'en-US') > estimateSpeechMs('Hello there', 'en-US'));
});
