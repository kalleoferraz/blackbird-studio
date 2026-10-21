export interface WavOptions {
  seconds?: number;
  sampleRate?: number;
  channels?: number;
  bits?: 8 | 16 | 24 | 32;
  float?: boolean;
  /** Written into the sound, so different seeds give different recordings. */
  seed?: number;
  /** Extra chunk before the data, to test files with tags. */
  list?: boolean;
  /** Write 0 as the data size, as a recorder that could not fix the header does. */
  openData?: boolean;
  extensible?: boolean;
  /** Cut this many bytes off the end. */
  cut?: number;
}

/** A tone as a WAV file: a sine whose frequency depends on the seed. */
export function wavFile(o: WavOptions = {}): Buffer {
  const { seconds = 1, sampleRate = 48000, channels = 2, bits = 24, float = false, seed = 1 } = o;
  const frames = Math.round(seconds * sampleRate), bytes = bits / 8, align = channels * bytes;
  const data = Buffer.alloc(frames * align);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.sin((2 * Math.PI * (220 + seed * 37 + c * 11) * i) / sampleRate) * 0.6;
      const at = i * align + c * bytes;
      if (float) data.writeFloatLE(v, at);
      else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), at);
      else if (bits === 24) { const n = Math.round(v * 8388607); data[at] = n & 255; data[at + 1] = (n >> 8) & 255; data[at + 2] = (n >> 16) & 255; }
      else if (bits === 32) data.writeInt32LE(Math.round(v * 2147483647), at);
      else data[at] = Math.round(v * 127 + 128);
    }
  }
  const fmtBody = Buffer.alloc(o.extensible ? 40 : 16);
  fmtBody.writeUInt16LE(o.extensible ? 0xfffe : float ? 3 : 1, 0);
  fmtBody.writeUInt16LE(channels, 2);
  fmtBody.writeUInt32LE(sampleRate, 4);
  fmtBody.writeUInt32LE(sampleRate * align, 8);
  fmtBody.writeUInt16LE(align, 12);
  fmtBody.writeUInt16LE(bits, 14);
  if (o.extensible) { fmtBody.writeUInt16LE(22, 16); fmtBody.writeUInt16LE(bits, 18); fmtBody.writeUInt32LE(3, 20); fmtBody.writeUInt16LE(float ? 3 : 1, 24); }
  const chunk = (id: string, body: Buffer, size = body.length) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(size, 4);
    return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const parts = [chunk('fmt ', fmtBody)];
  if (o.list) parts.push(chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00test\x00', 'binary')));
  parts.push(chunk('data', data, o.openData ? 0 : data.length));
  const body = Buffer.concat([Buffer.from('WAVE'), ...parts]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  const all = Buffer.concat([head, body]);
  return o.cut ? all.subarray(0, all.length - o.cut) : all;
}
