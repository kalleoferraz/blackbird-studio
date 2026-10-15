import Fastify, { type FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  // The host's health check does GET / on 127.0.0.1:<port>; it must return 200.
  app.get('/', async () => ({ ok: true, name: 'audiobook-studio' }));

  app.get('/health', async () => ({
    status: 'ok',
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  }));

  return app;
}
