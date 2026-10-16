/**
 * Local test server for the spike route:  npx tsx scripts/dev-server.ts
 * The guard here is a shared token in the `x-spike-token` header (env SPIKE_TOKEN). In the real app, plug in
 * whatever guards the other /spike/* routes (or the admin session) instead.
 */
import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { imageSpikeRoutes } from '../../../src/spike/image/route.js';

const token = process.env.SPIKE_TOKEN;
if (!token) throw new Error('set SPIKE_TOKEN');

const app = Fastify({ logger: { level: 'warn' } });
await app.register(imageSpikeRoutes, {
  authorize(request) {
    const given = Buffer.from(String(request.headers['x-spike-token'] ?? ''));
    const wanted = Buffer.from(token);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }
  },
});
app.get('/', async () => 'ok'); // the host's health check
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`listening on http://127.0.0.1:${port}`);
