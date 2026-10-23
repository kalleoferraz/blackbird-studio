import assert from 'node:assert/strict';
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ZipArchive } from 'archiver';
import { readZipEntry, readZipIndex } from '../web/src/zip.js';

async function makeZip(files: Record<string, Buffer>, options: object = {}): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), 'zip-'));
  const file = path.join(dir, 'a.zip');
  try {
    const archive = new ZipArchive(options);
    const out = createWriteStream(file);
    const done = new Promise<void>((resolve, reject) => { out.on('close', resolve); archive.on('error', reject); });
    archive.pipe(out);
    for (const [name, data] of Object.entries(files)) archive.append(data, { name, store: name.endsWith('.mp3') });
    await archive.finalize();
    await done;
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('zip reader', () => {
  const files = {
    'Storyline/01 - Intro/take (1).wav': Buffer.alloc(200_000, 7), // compresses: deflated
    'Characters/Ana/pictures/ana.png': Buffer.from('not really a png'),
    'ünï côdé.mp3': Buffer.from('stored bytes'), // stored, non-ASCII name
    'empty-ish.txt': Buffer.from('x'),
  };

  it('lists and extracts deflated and stored entries, with non-ASCII names', async () => {
    const zip = await makeZip(files);
    const blob = new Blob([zip]);
    const entries = await readZipIndex(blob);
    assert.deepEqual(entries.map((e) => e.name).sort(), Object.keys(files).sort());
    for (const e of entries) {
      const bytes = Buffer.from(await (await readZipEntry(blob, e)).arrayBuffer());
      assert.ok(bytes.equals(files[e.name as keyof typeof files]!), e.name);
      assert.equal(e.size, bytes.length);
    }
    assert.equal(entries.find((e) => e.name.endsWith('.wav'))!.method, 8);
    assert.equal(entries.find((e) => e.name.endsWith('.mp3'))!.method, 0);
  });

  it('reads zip64 archives', async () => {
    const zip = await makeZip(files, { forceZip64: true });
    const blob = new Blob([zip]);
    const entries = await readZipIndex(blob);
    assert.equal(entries.length, 4);
    const e = entries.find((x) => x.name === 'empty-ish.txt')!;
    assert.equal(Buffer.from(await (await readZipEntry(blob, e)).arrayBuffer()).toString(), 'x');
  });

  it('refuses what is not a zip', async () => {
    await assert.rejects(() => readZipIndex(new Blob([Buffer.from('hello, I am not a zip file at all')])), /not a zip/);
  });
});
