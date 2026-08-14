// fallow-ignore-file
import { defineConfig } from 'vite';

// Offscreen audio controller build. public/offscreen.html loads it as a
// classic <script>, so it is bundled as a single IIFE file (no ES module
// support required in the offscreen document).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      input: 'src/offscreen/audio.ts',
      output: {
        entryFileNames: 'offscreen.js',
        chunkFileNames: 'offscreen-[hash].js',
        assetFileNames: 'offscreen-[name][extname]',
        format: 'iife',
      },
    },
  },
});