/**
 * The root package.json has "type": "module" (needed for Vite/tsx/the
 * rest of this project), but tsconfig.server.json compiles the backend
 * to CommonJS (require/exports) — the most compatible, battle-tested
 * output for a plain `node dist-server/server/index.js` run, no bundler
 * involved. Node resolves a .js file's module system from the NEAREST
 * ancestor package.json's "type" field, so without this marker file the
 * compiled output would inherit "module" from the root and immediately
 * fail with "require is not defined in ES module scope".
 *
 * Run after `tsc -p tsconfig.server.json` as part of `npm run build` —
 * see package.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist-server', { recursive: true });
writeFileSync('dist-server/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
console.log('[build] wrote dist-server/package.json ({"type":"commonjs"})');
