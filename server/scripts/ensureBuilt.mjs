/**
 * Pre-flight check for `npm start`. Node's own "Cannot find module
 * dist-server/server/index.js" error gives no hint about *why* — this
 * prints an actionable message instead, for the single most common cause:
 * `npm run build` was never run (or failed) before `npm start`.
 */
import { existsSync } from 'node:fs';

const entry = 'dist-server/server/index.js';

if (!existsSync(entry)) {
  console.error(
    [
      '',
      `[start] ${entry} does not exist.`,
      '',
      "This means `npm run build` hasn't been run yet, or it failed.",
      'Run it on its own first and read its full output:',
      '',
      '    npm run build',
      '',
      'If that reports a TypeScript error, fix that first — `npm start`',
      'cannot succeed without a successful build. If it reports no error',
      'but dist-server/ still looks empty afterward, check that `tsc` is',
      'actually installed (`npm install` completed without errors).',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
