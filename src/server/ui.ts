import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

// The React app is built into ./public/app (npm run web:build) and the built files are committed, because the
// host may not run a build. The path works from src/ and from dist/.
const appFolder = fileURLToPath(new URL('../../public/app/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
};

export function registerUi(app: FastifyInstance): void {
  const send = async (reply: import('fastify').FastifyReply, file: string) => {
    const ext = file.slice(file.lastIndexOf('.'));
    const type = TYPES[ext];
    let content: Buffer;
    try { content = await readFile(appFolder + file); } catch { return reply.code(404).send({ error: 'not_found' }); }
    const isAsset = file.startsWith('assets/');
    return reply
      .header('content-type', type ?? 'application/octet-stream')
      .header('cache-control', isAsset ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'same-origin')
      .header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      .send(content);
  };
  app.get('/app', async (_req, reply) => send(reply, 'index.html'));
  app.get('/app/', async (_req, reply) => send(reply, 'index.html'));
  app.get('/app/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^[\w-]+\.(svg|png|ico)$/.test(name)) return reply.code(404).send({ error: 'not_found' });
    return send(reply, name);
  });
  app.get('/app/assets/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) return reply.code(404).send({ error: 'not_found' });
    return send(reply, `assets/${name}`);
  });
}
