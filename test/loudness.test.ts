import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoudnessMeter, SILENCE_DB } from '../src/audio/loudness.js';
import { AUTO_MAX_BOOST_DB, levelFor } from '../src/server/levels.js';

const sine = (rate: number, seconds: number, amp: number, hz = 1000) => {
  const n = Math.round(rate * seconds), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};
const measure = (rate: number, channels: Float32Array[], block = 4096) => {
  const m = new LoudnessMeter(rate);
  for (let at = 0; at < channels[0]!.length; at += block) m.push(channels.map((c) => c.subarray(at, at + block)));
  return m.result();
};

test('a 1 kHz sine at full scale in one channel measures -3.01 LUFS (BS.1770), at any rate and block size', () => {
  for (const rate of [44100, 48000]) {
    const r = measure(rate, [sine(rate, 5, 1)], rate === 48000 ? 1000 : 4096);
    assert.ok(Math.abs(r.lufs! - -3.01) < 0.05, `${rate}: ${r.lufs}`);
    assert.ok(Math.abs(r.peakDb) < 0.01);
  }
});

test('the same sine at -20 dBFS on two channels measures -20 LUFS', () => {
  const s = sine(48000, 5, 0.1);
  const r = measure(48000, [s, s]);
  assert.ok(Math.abs(r.lufs! - -20) < 0.05, String(r.lufs));
});

test('silence and very short audio have no loudness', () => {
  assert.deepEqual(measure(48000, [new Float32Array(48000 * 3)]), { lufs: null, peakDb: SILENCE_DB });
  assert.equal(measure(48000, [sine(48000, 0.3, 0.5)]).lufs, null);
});

test('quiet passages below the relative gate do not pull the measurement down', () => {
  const loud = sine(48000, 5, 0.1), quiet = sine(48000, 20, 0.001), both = new Float32Array(loud.length + quiet.length);
  both.set(loud); both.set(quiet, loud.length);
  assert.ok(Math.abs(measure(48000, [both]).lufs! - -23.01) < 0.2); // the blocks across the change still count
});

test('levelFor: matches the target, stops at the boost and peak limits, says when it is limited', () => {
  assert.deepEqual(levelFor({ lufs: -24, peakDb: -12 }, -18), { gainDb: 6, levelAuto: 'auto' });
  assert.deepEqual(levelFor({ lufs: -15, peakDb: -2 }, -18), { gainDb: -3, levelAuto: 'auto' });
  assert.deepEqual(levelFor({ lufs: -40, peakDb: -30 }, -18), { gainDb: AUTO_MAX_BOOST_DB, levelAuto: 'limited' });
  assert.deepEqual(levelFor({ lufs: -26, peakDb: -4 }, -18), { gainDb: 3, levelAuto: 'limited' }); // peak may rise to -1 dBFS only
  assert.equal(levelFor({ lufs: null, peakDb: SILENCE_DB }, -18), null);
  assert.equal(levelFor(null, -18), null);
});
