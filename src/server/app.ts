import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import { imageSpikeRoutes } from '../spike/image/route.js';
import { registerUi } from './ui.js';

export function buildApp(): FastifyInstance {
  // The host sits behind a proxy: trust it for the client address (login rate limit). A forged
  // X-Forwarded-For can dodge the per-address limit, but not the per-account one.
  const app = Fastify({ logger: true, trustProxy: true });

  // The host's health check does GET / on 127.0.0.1:<port>; it must return 200.
  app.get('/', async () => ({ ok: true, name: 'audiobook-studio' }));

  app.get('/health', async () => ({
    status: 'ok',
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  }));

  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerUi(app);

  // Image resizer spike (removed after the spike): only exists when SPIKE_TOKEN is set, and every
  // request must carry it in the x-spike-token header.
  const spikeToken = process.env.SPIKE_TOKEN;
  if (spikeToken) {
    void app.register(imageSpikeRoutes, {
      authorize(request) {
        const given = Buffer.from(String(request.headers['x-spike-token'] ?? ''));
        const wanted = Buffer.from(spikeToken);
        if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
          throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
        }
      },
    });
  }

  return app;
}
