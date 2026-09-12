// Synthetic fixtures for issue #201, written only to a new temporary directory.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'aqbot-selection-201-'));
const fixtures = [100, 500, 1000].map((lines) => {
  const text = Array.from({ length: lines }, (_, line) => (
    line === 0 || line === lines - 1
      ? '\n'
      : `    const value_${line} = "长代码 🧪 {selection}";\n`
  )).join('');
  const path = join(directory, `selection-${lines}.ts`);
  writeFileSync(path, text, 'utf8');
  return {
    path,
    lines,
    characters: Array.from(text).length,
    utf8Bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
});

console.log(JSON.stringify({ directory, fixtures }, null, 2));
