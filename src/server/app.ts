import Fastify, { type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin-routes.js';
import { registerAuthRoutes } from './auth-routes.js';
import { registerCharacterRoutes } from './characters.js';
import { registerErrorHandler } from './http.js';
import { registerLibraryRoutes } from './library.js';
import { registerNoteRoutes } from './notes.js';
import { registerProjectRoutes } from './projects.js';
import { registerSnapshotRoutes } from './snapshots.js';
import { registerStoryRoutes } from './story.js';
import { registerTransferRoutes } from './transfer.js';
import { registerUi } from './ui.js';
import { registerVoiceAdminRoutes } from './voice-admin.js';
import { registerVoiceRoutes } from './voices.js';

export function buildApp(): FastifyInstance {
  // The host sits behind a proxy: trust it for the client address (login rate limit). A forged
  // X-Forwarded-For can dodge the per-address limit, but not the per-account one.
  const app = Fastify({ logger: true, trustProxy: true });

  // GET / is the app itself (registerUi). The host's health check also does GET / on 127.0.0.1:<port> and needs a 200.

  app.get('/health', async () => ({
    status: 'ok',
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  }));

  registerErrorHandler(app);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerVoiceAdminRoutes(app);
  registerTransferRoutes(app);
  registerProjectRoutes(app);
  registerStoryRoutes(app);
  registerCharacterRoutes(app);
  registerVoiceRoutes(app);
  registerLibraryRoutes(app);
  registerNoteRoutes(app);
  registerSnapshotRoutes(app);
  registerUi(app);

  return app;
}
