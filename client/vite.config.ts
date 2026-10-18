import { defineConfig } from 'vite';

const backend = 'http://localhost:8080';

export default defineConfig({
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: backend, ws: true, changeOrigin: true },
      '/data': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'static', // keep clear of public/assets (game assets)
    chunkSizeWarningLimit: 1500,
  },
});
