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

import { PALETTE, nextColour, COLOUR_PATTERN } from '../src/shared/palette.js';
test('palette colours are valid, unique, and the next colour skips used ones and black', () => {
  const hexes = PALETTE.map((c) => c.hex.toLowerCase());
  assert.equal(new Set(hexes).size, hexes.length);
  assert.ok(PALETTE.every((c) => COLOUR_PATTERN.test(c.hex)));
  assert.equal(nextColour([]), '#F2605C');
  assert.equal(nextColour(['#f2605c']), '#6FA8FF');
  assert.ok(!PALETTE.slice(0, -1).some((c) => c.hex === '#000000'));
  assert.notEqual(nextColour(PALETTE.filter((c) => c.hex !== '#000000').map((c) => c.hex)).toLowerCase(), '#000000');
});

test('the speech estimate follows what the project has recorded', async () => {
  const { msPerUnit, speechUnits } = await import('../src/shared/estimate.js');
  const text = 'Hello there, how are you doing today my friend?';
  const base = estimateSpeechMs(text, 'en-US');
  assert.equal(estimateSpeechMs(text, 'en-US', { units: 0, ms: 0 }), base);
  const units = speechUnits(text, 'en-US');
  // A slower speaker: the same text took 50 % longer, over a lot of recordings.
  const slow = { units: 1000, ms: 1000 * 300 };
  assert.ok(msPerUnit('en-US', slow) > 270 && msPerUnit('en-US', slow) < 300);
  assert.ok(estimateSpeechMs(text, 'en-US', slow) > base * 1.3);
  // A line break is worth the syllables its pause is worth.
  assert.ok(speechUnits('One\n\nTwo', 'en-US') > speechUnits('One Two', 'en-US'));
  assert.ok(units > 8);
});
