import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import { encodeWavToMp3 } from '../src/audio/encode.js';
import { AudioError } from '../src/audio/errors.js';
import { parseMp3 } from '../src/audio/mp3.js';
import { PeakAccumulator, peakAmplitude, peakByte, peaksFromMp3, peaksFromWav } from '../src/audio/peaks.js';
import { parseWav, readFloatChannels, wavSamples } from '../src/audio/wav.js';
import { wavFile } from './support/wav.js';

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof AudioError ? `${e.status} ${e.code}` : String(e); }
  return 'no error';
};

describe('WAV header', () => {
  it('reads 24-bit stereo', () => {
    const i = parseWav(wavFile({ seconds: 1.5 }));
    assert.deepEqual([i.sampleRate, i.channels, i.bitDepth, i.sampleFormat, i.frames, i.durationMs], [48000, 2, 24, 'pcm', 72000, 1500]);
  });
  it('reads 16-bit mono, 32-bit float and the extensible header', () => {
    assert.equal(parseWav(wavFile({ bits: 16, channels: 1, sampleRate: 44100 })).bitDepth, 16);
    const f = parseWav(wavFile({ bits: 32, float: true }));
    assert.equal(f.sampleFormat, 'float');
    assert.equal(parseWav(wavFile({ extensible: true, float: true, bits: 32 })).sampleFormat, 'float');
  });
  it('skips other chunks, and takes a data size of 0 as "to the end"', () => {
    assert.equal(parseWav(wavFile({ list: true })).durationMs, 1000);
    assert.equal(parseWav(wavFile({ openData: true })).durationMs, 1000);
  });
  it('refuses what it cannot use, with a clear status', () => {
    assert.equal(code(() => parseWav(Buffer.from('not a wav file at all, but long enough to have a header....................'))), '422 audio_unreadable');
    assert.equal(code(() => parseWav(wavFile({ cut: 5000 }))), '422 audio_unreadable'); // cut short
    assert.equal(code(() => parseWav(wavFile({ bits: 8 }))), '415 unsupported_audio');
    assert.equal(code(() => parseWav(wavFile({ channels: 3 }))), '415 unsupported_audio');
    assert.equal(code(() => parseWav(wavFile({ seconds: 0 }))), '422 audio_unreadable');
  });
  it('decodes the samples', () => {
    const [l] = readFloatChannels(wavFile({ bits: 16, channels: 1 }), parseWav(wavFile({ bits: 16, channels: 1 })), 0, 4);
    assert.ok(l!.length === 4 && Math.abs(l![0]!) < 0.01 && l![3]! > 0);
    for (const o of [{ bits: 24 }, { bits: 32 }, { bits: 32, float: true }] as const) {
      const buf = wavFile({ ...o, seconds: 0.1 }), info = parseWav(buf), [a] = readFloatChannels(buf, info, 1000, 1);
      const expected = Math.sin((2 * Math.PI * (220 + 37) * 1000) / 48000) * 0.6;
      assert.ok(Math.abs(a![0]! - expected) < 1e-4, `${o.bits} ${a![0]} vs ${expected}`);
    }
  });
  it('hashes the samples only', () => {
    const a = wavFile({ seed: 3 }), b = wavFile({ seed: 3, list: true });
    assert.notDeepEqual(a, b);
    assert.deepEqual(Buffer.from(wavSamples(a, parseWav(a))), Buffer.from(wavSamples(b, parseWav(b))));
  });
});

describe('MP3 encoding and reading', () => {
  it('encodes a WAV and reads back the same length', async () => {
    const mp3 = await encodeWavToMp3(wavFile({ seconds: 3 }));
    const i = parseMp3(mp3);
    assert.equal(i.format, 'mp3');
    assert.equal(i.sampleRate, 48000);
    assert.equal(i.channels, 2);
    assert.ok(Math.abs(i.durationMs - 3000) < 60, `duration ${i.durationMs}`);
    assert.ok(i.bitrateKbps >= 100 && i.bitrateKbps <= 140, `bit rate ${i.bitrateKbps}`);
  });
  it('encodes mono, 44.1 kHz and 96 kHz sources', async () => {
    const mono = parseMp3(await encodeWavToMp3(wavFile({ seconds: 2, channels: 1, bits: 16, sampleRate: 44100 })));
    assert.deepEqual([mono.channels, mono.sampleRate], [1, 44100]);
    const hi = parseMp3(await encodeWavToMp3(wavFile({ seconds: 2, sampleRate: 96000 })));
    assert.ok(Math.abs(hi.durationMs - 2000) < 80, `duration ${hi.durationMs}`);
  });
  it('skips an ID3 tag in front, and finds the length without a Xing header', async () => {
    const mp3 = Buffer.from(await encodeWavToMp3(wavFile({ seconds: 2 })));
    const tag = Buffer.alloc(10 + 300);
    tag.write('ID3', 0, 'ascii'); tag[3] = 3; tag[8] = 300 >> 7; tag[9] = 300 & 127; // syncsafe size
    const tagged = parseMp3(Buffer.concat([tag, mp3]));
    assert.ok(Math.abs(tagged.durationMs - 2000) < 60);
    // cut the first (Xing) frame off: the frames are then counted one by one
    const plain = parseMp3(mp3.subarray(417)); // one 128 kbit/s frame at 48 kHz is 384 bytes; 417 skips it and some of the next
    assert.ok(plain.durationMs > 1900);
  });
  it('refuses a file that is not an MP3', () => {
    assert.equal(code(() => parseMp3(Buffer.from('hello hello hello'.repeat(100)))), '422 audio_unreadable');
    assert.equal(code(() => parseMp3(Buffer.alloc(2000))), '422 audio_unreadable');
  });
});

describe('peaks', () => {
  it('maps amplitude to a decibel byte and back', () => {
    assert.equal(peakByte(0), 0);
    assert.equal(peakByte(1), 255);
    assert.equal(peakByte(0.001), 0); // -60 dB
    assert.equal(peakByte(0.1), 170); // -20 dB
    assert.ok(Math.abs(peakAmplitude(peakByte(0.25)) - 0.25) < 0.01);
    assert.equal(peakAmplitude(0), 0);
  });
  it('gives one value per 100 ms whatever the sample rate and block size', () => {
    for (const sr of [8000, 11025, 22050, 44100, 48000, 96000]) {
      const n = Math.round(sr * 1.05), ch = new Float32Array(n).fill(0.5);
      const acc = new PeakAccumulator(sr);
      for (let i = 0; i < n; i += 7777) acc.push([ch.subarray(i, i + 7777)]);
      const p = acc.finish();
      assert.equal(p.length, 11, `${sr} Hz`); // 1.05 s: ten full windows and a partial one
      assert.ok(p.every((v) => v === peakByte(0.5)));
    }
  });
  it('takes the louder channel, and finds a short click in a quiet file', () => {
    const l = new Float32Array(48000).fill(0.01), r = new Float32Array(48000).fill(0.02);
    l[24000] = 0.9; // at 0.5 s: window 5
    const p = new PeakAccumulator(48000);
    p.push([l, r]);
    const out = p.finish();
    assert.equal(out[4], peakByte(0.02));
    assert.equal(out[5], peakByte(0.9));
  });
  it('reads peaks from a WAV and from its MP3 with about the same shape', async () => {
    const wav = wavFile({ seconds: 3 });
    const fromWav = peaksFromWav(wav);
    assert.equal(fromWav.length, 30);
    const mp3 = await encodeWavToMp3(wav);
    const fromMp3 = await peaksFromMp3(mp3);
    assert.ok(Math.abs(fromMp3.length - 30) <= 1, `length ${fromMp3.length}`);
    for (let i = 2; i < 28; i++) assert.ok(Math.abs(fromMp3[i]! - fromWav[i]!) < 12, `window ${i}: ${fromMp3[i]} vs ${fromWav[i]}`);
  });
  it('is silent for silence', () => {
    const acc = new PeakAccumulator(44100);
    acc.push([new Float32Array(44100)]);
    assert.ok(acc.finish().every((v) => v === 0));
  });
});

after(async () => {
  const { closeEncodePool } = await import('../src/audio/pool.js');
  await closeEncodePool();
});
