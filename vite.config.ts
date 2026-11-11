import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/WM-Sim/' : '/',
  server: { host: true, proxy: { '/api': 'http://localhost:3001' } },
});
