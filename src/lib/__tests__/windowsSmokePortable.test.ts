import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = readFileSync(
  resolve(process.cwd(), 'scripts/windows/smoke-portable.ps1'),
  'utf8',
);

describe('Windows portable smoke script', () => {
  it('reads the live AQBot log with write sharing instead of ReadAllText', () => {
    expect(script).not.toMatch(/\[IO\.File\]::ReadAllText/);
    expect(script).toMatch(/\[IO\.FileShare\]::ReadWrite/);
    expect(script).toMatch(/\$current -is \[IO\.IOException\]/);
    expect(script).toMatch(/shared-log-probe/);
    expect(script).toMatch(/AQBot startup surface presented/);
  });
});
