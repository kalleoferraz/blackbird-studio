import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

// The first screens (login, password change, accounts) are plain files in ./public, served without a
// build step; the React app replaces them later. The path works from src/ and from dist/.
const publicFolder = fileURLToPath(new URL('../../public/', import.meta.url));

const FILES: Record<string, { file: string; type: string }> = {
  '/app': { file: 'app.html', type: 'text/html; charset=utf-8' },
  '/app/': { file: 'app.html', type: 'text/html; charset=utf-8' },
  '/app/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

export function registerUi(app: FastifyInstance): void {
  for (const [route, { file, type }] of Object.entries(FILES)) {
    app.get(route, async (_request, reply) => {
      const content = await readFile(publicFolder + file);
      return reply
        .header('content-type', type)
        .header('cache-control', 'no-cache')
        .header('x-content-type-options', 'nosniff')
        .header('x-frame-options', 'DENY')
        .header('referrer-policy', 'same-origin')
        .header('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        .send(content);
    });
  }
}
