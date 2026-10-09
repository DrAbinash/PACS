import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.TR_DEV_API ?? 'http://127.0.0.1:3101';
// Same-origin is a security property here, not a convenience: the session cookie is
// SameSite=Strict and HttpOnly, so a second origin would mean either dropping that
// or putting a token in local storage. Both proxies exist so `dev` and `preview`
// behave like the one deployment, where Caddy routes /v1 to the api.
const proxy = {
  '/v1': { target: apiTarget, changeOrigin: false },
  '/health': { target: apiTarget, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: { outDir: 'dist', sourcemap: true },
});
