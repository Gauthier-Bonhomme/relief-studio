import { defineConfig } from 'vite';

// Chemins relatifs : le site peut être servi depuis un sous-dossier (GitHub Pages).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { port: 5180 },
});
