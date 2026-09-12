import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const basePath = process.env.BASE_PATH || '/launch';
const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
const apiTarget = `http://127.0.0.1:${process.env.API_PORT || 3210}`;

export default defineConfig({
  root: here,
  base,
  plugins: [react()],
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true
  },
  server: {
    port: Number(process.env.DEV_PORT || 5173),
    proxy: {
      [`${basePath}/api`]: apiTarget,
      [`${basePath}/health`]: apiTarget
    }
  }
});
