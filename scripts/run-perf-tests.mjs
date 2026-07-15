#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');
const child = spawn(
  process.execPath,
  [playwrightCli, 'test', '--config=playwright.perf.config.ts', ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    env: { ...process.env, PERF_ENFORCE: '1' },
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Performance test process exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
