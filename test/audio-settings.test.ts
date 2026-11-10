import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanPoints, envelopeGain, envelopeValue, sourceAt } from '../src/shared/audio-settings.js';

describe('envelopes', () => {
  it('validates and sorts the points of each kind', () => {
    assert.deepEqual(cleanPoints([[500, 2], [0, 0.5]], 1000, 'speed'), [[0, 0.5], [500, 2]]);
    assert.equal(cleanPoints([[0, 3]], 1000, 'speed'), undefined); // faster than allowed
    assert.equal(cleanPoints([[0, 1300]], 1000, 'pitch'), undefined);
    assert.deepEqual(cleanPoints([[0, 30]], 1000, 'level'), [[0, 30]]); // a big boost is allowed
    assert.equal(cleanPoints([], 1000, 'level'), null);
  });

  it('interpolates: dB and cents linearly, a speed by octaves', () => {
    assert.equal(envelopeValue([[0, -100], [1000, 100]], 500, 'pitch'), 0);
    assert.equal(envelopeValue([[0, 0.5], [1000, 2]], 500, 'speed'), 1);
    assert.equal(envelopeValue(null, 100, 'speed'), 1);
    assert.ok(Math.abs(envelopeGain([[0, 20]], 0) - 10) < 1e-9);
  });

  it('measures how much of the file a speed envelope reads', () => {
    assert.equal(sourceAt(1.5, null, 1000), 1500);
    assert.equal(Math.round(sourceAt(1, [[0, 2], [5000, 2]], 1000)), 2000);
    assert.equal(Math.round(sourceAt(1, [[0, 1], [1000, 2]], 1000)), Math.round(1000 / Math.LN2));
    assert.equal(Math.round(sourceAt(1, [[500, 2], [1000, 2]], 250)), 500);
  });
});
