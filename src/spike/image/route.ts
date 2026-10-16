import os from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { packageVersion } from './resizers/util.js';
import { ResizeWorkerPool } from './pool.js';
import { DEFAULTS, processImage, type ProcessResult } from './process.js';
import { LIB_IDS, type ImageFormat, type LibId } from './types.js';

export interface ImageSpikeOptions {
  /**
   * Required. Runs before every spike route and must throw an error with `statusCode` 401 or 403 to refuse.
   * There is deliberately no default: these routes decode uploaded files and must never be open.
   */
  authorize: (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;
  pool?: ResizeWorkerPool;
  /** Largest upload accepted by the spike. The product limit for a cover or a character picture is 10 MB. */
  maxBodyBytes?: number;
}

const MIME: Record<ImageFormat, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;

function processInfo() {
  const mem = process.memoryUsage();
  return {
    rssMB: mb(mem.rss),
    heapUsedMB: mb(mem.heapUsed),
    externalMB: mb(mem.external),
    arrayBuffersMB: mb(mem.arrayBuffers),
    maxRssMB: mb(process.resourceUsage().maxRSS * 1024), // kilobytes in, megabytes out
    uptimeS: Math.round(process.uptime()),
  };
}

/** The result without the image bytes, as JSON. */
function describe(r: ProcessResult) {
  if (r.status === 'resized') {
    const { data: _data, ...output } = r.output;
    return { status: r.status, lib: r.lib, libVersion: r.libVersion, inspection: r.inspection, output, metrics: r.metrics, process: processInfo() };
  }
  return { ...r, process: processInfo() };
}

/**
 * Spike routes (remove with the other /spike/* routes when the spike is done):
 *   GET  /spike/image/info
 *   POST /spike/image/resize?lib=wasm-vips|jimp|jsquash&name=photo.jpg&quality=82&return=json|file
 * The body is the raw image file. `return=file` answers with the resized image and the numbers in the
 * `x-spike-result` header; the default answers with the numbers as JSON.
 */
export async function imageSpikeRoutes(app: FastifyInstance, opts: ImageSpikeOptions): Promise<void> {
  const pool = opts.pool ?? new ResizeWorkerPool();
  const bodyLimit = opts.maxBodyBytes ?? 25 * 1024 * 1024;

  app.addHook('onRequest', async (request, reply) => {
    await opts.authorize(request, reply);
  });
  app.addHook('onClose', async () => {
    if (!opts.pool) await pool.close();
  });

  // Scoped to this plugin, so the rest of the app keeps its own body parsers.
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit },
    (_request, body, done) => done(null, body),
  );

  app.get('/spike/image/info', async () => ({
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    libraries: Object.fromEntries(
      LIB_IDS.map((id) => [id, id === 'jsquash' ? packageVersion('@jsquash/jpeg') : packageVersion(id)]),
    ),
    defaults: DEFAULTS,
    maxBodyMB: mb(bodyLimit),
    process: processInfo(),
  }));

  app.post('/spike/image/resize', async (request, reply) => {
    const q = request.query as { lib?: string; name?: string; quality?: string; return?: string };
    const lib = (q.lib ?? 'wasm-vips') as LibId;
    if (!LIB_IDS.includes(lib)) return reply.code(400).send({ error: `lib must be one of ${LIB_IDS.join(', ')}` });
    const body = request.body;
    if (!(body instanceof Buffer)) {
      return reply.code(415).send({ error: 'send the raw image file as the body (image/jpeg, image/png, image/webp, image/gif or application/octet-stream)' });
    }
    const quality = q.quality ? Math.min(100, Math.max(1, Number(q.quality) || DEFAULTS.quality)) : DEFAULTS.quality;

    const result = await processImage(new Uint8Array(body.buffer, body.byteOffset, body.length), {
      lib,
      name: q.name ?? 'upload.jpg',
      quality,
      pool,
    });

    if (result.status === 'failed') return reply.code(422).send(describe(result));
    if (result.status === 'resized' && q.return === 'file') {
      reply
        .header('content-type', MIME[result.output.format])
        .header('content-disposition', `inline; filename="${result.output.name.replace(/"/g, '')}"`)
        .header('x-spike-result', JSON.stringify(describe(result)));
      return reply.send(Buffer.from(result.output.data));
    }
    return describe(result);
  });
}
