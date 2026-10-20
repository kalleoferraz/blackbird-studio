import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app goes to ../public/app and is served by Fastify under /app/.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: '../public/app', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
