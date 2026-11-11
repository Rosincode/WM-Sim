import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/WM-Sim/' : '/',
  build: { chunkSizeWarningLimit: 1000 },
  server: { host: true, proxy: { '/api': 'http://localhost:3001' } },
});
