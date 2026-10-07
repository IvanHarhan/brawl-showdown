import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  publicDir: fileURLToPath(new URL('../assets', import.meta.url)),
  server: { host: true, port: 5173, fs: { allow: ['..'] } },
  preview: { host: true, port: 4173 },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 1500 },
});
