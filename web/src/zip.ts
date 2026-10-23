/**
 * A small zip reader for the browser, so a library zip can be unpacked one file at a time without loading the
 * whole archive: it reads the central directory at the end (zip64 included), then slices out one entry when asked
 * and inflates it with the browser's own DecompressionStream. Only stored and deflated entries, no encryption.
 */
export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: number;
  offset: number;
  directory: boolean;
}

const u16 = (v: DataView, o: number) => v.getUint16(o, true);
const u32 = (v: DataView, o: number) => v.getUint32(o, true);
const u64 = (v: DataView, o: number) => Number(v.getBigUint64(o, true));

export async function readZipIndex(blob: Blob): Promise<ZipEntry[]> {
  const tailSize = Math.min(blob.size, 22 + 65_535);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tailSize - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a zip file.');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // zip64: the locator sits right before the end record and points at the zip64 end record
    if (eocd < 20 || u32(tail, eocd - 20) !== 0x07064b50) throw new Error('The zip file is damaged (zip64 locator missing).');
    const recordAt = u64(tail, eocd - 20 + 8);
    const rec = new DataView(await blob.slice(recordAt, recordAt + 56).arrayBuffer());
    if (u32(rec, 0) !== 0x06064b50) throw new Error('The zip file is damaged (zip64 record missing).');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  const buf = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cd = new DataView(buf);
  const text = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength || u32(cd, p) !== 0x02014b50) throw new Error('The zip file is damaged (bad directory).');
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compressedSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = text.decode(new Uint8Array(buf, p + 46, nameLen));
    if (flags & 1) throw new Error('Encrypted zip files are not supported.');
    // zip64 extra field: only the values that did not fit are present, in this order
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }
    entries.push({ name, size, compressedSize, method, offset, directory: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The uncompressed bytes of one entry, as a Blob (held in memory: one file at a time). */
export async function readZipEntry(blob: Blob, entry: ZipEntry): Promise<Blob> {
  const head = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
  if (u32(head, 0) !== 0x04034b50) throw new Error(`The zip file is damaged (bad entry "${entry.name}").`);
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = blob.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`"${entry.name}" uses a compression this reader does not support.`);
  return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
}
