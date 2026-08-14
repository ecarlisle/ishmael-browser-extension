import { defineConfig } from 'vite';

// Content script build. Chrome content scripts cannot use ES module imports,
// so everything (including Readability) is bundled into one IIFE file.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      input: 'src/content/extract.ts',
      output: {
        entryFileNames: 'content.js',
        chunkFileNames: 'content-[hash].js',
        assetFileNames: 'content-[name][extname]',
        format: 'iife',
      },
    },
  },
});