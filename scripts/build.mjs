// Runs the three Vite builds in dependency-safe order.
//   node scripts/build.mjs   (or: pnpm build)
//
// 1. App build (popup + service worker), which also empties dist and copies
//    public/ into it.
// 2. Content script build (single IIFE file).
// 3. Offscreen controller build (single IIFE file).
//
// Run sequentially because builds 2 and 3 must not wipe the app output.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'node_modules', '.bin', 'vite');

function run(label, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(BIN, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`Build step failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

run('app (popup + service worker)', ['build']);
run('content script', ['build', '--config', 'vite.content.config.ts']);
run('offscreen controller', ['build', '--config', 'vite.offscreen.config.ts']);
