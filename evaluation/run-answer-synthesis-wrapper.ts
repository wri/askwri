/**
 * TS wrapper for the Python answer-synthesis eval.
 *
 * Spawns `python3 evaluation/run-answer-synthesis-eval.py` with the
 * same --mode flag, streaming output through to the caller.
 *
 * Usage:
 *   npx tsx evaluation/run-answer-synthesis-wrapper.ts          # defaults to isolated
 *   npx tsx evaluation/run-answer-synthesis-wrapper.ts -- --mode end-to-end
 *   npm run eval:answer-synthesis -- --mode end-to-end
 */

import { spawn } from 'child_process';
import * as path from 'path';

const VALID_MODES = ['isolated', 'end-to-end'] as const;

function parseMode(argv: string[]): string {
  const idx = argv.indexOf('--mode');
  if (idx !== -1 && idx + 1 < argv.length) {
    const mode = argv[idx + 1];
    if (!VALID_MODES.includes(mode as any)) {
      console.error(`Invalid mode "${mode}". Must be one of: ${VALID_MODES.join(', ')}`);
      process.exit(1);
    }
    return mode;
  }
  return 'isolated';
}

const mode = parseMode(process.argv);
const scriptPath = path.join(__dirname, 'run-answer-synthesis-eval.py');

const child = spawn('python3', [scriptPath, '--mode', mode], {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});

child.on('error', (err) => {
  console.error(`Failed to start python3: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 1);
});
