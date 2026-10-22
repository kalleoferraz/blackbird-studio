import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app goes to ../public/app; Fastify serves the page at / and its files under /app/.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  // The audio worklet must stay a real file (a data: address is not allowed to run as a script).
  build: { outDir: '../public/app', emptyOutDir: true, sourcemap: false, assetsInlineLimit: (file) => (file.endsWith('recorder-worklet.js') ? false : undefined) },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
