import { defineConfig } from 'vite';
export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/WM-Sim/' : '/',
  build: { chunkSizeWarningLimit: 1000 },
  // Vaste poort: de WMS-app laat zich alleen insluiten (iframe) op http://localhost:5173 en de GitHub Page.
  // Is 5173 bezet, dan stopt Vite met een foutmelding in plaats van stilletjes naar 5174 uit te wijken.
  server: { host: true, port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:3001' } },
});
