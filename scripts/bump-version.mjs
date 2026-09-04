#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const autoPush = flags.has('--push');

const version = positional[0];
if (!version) {
  console.error('用法: pnpm bump [--push] <version>');
  console.error('示例: pnpm bump 0.0.11');
  console.error('      pnpm bump --push 0.0.11  (自动 push commit 和 tag)');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`无效版本号: ${version}`);
  process.exit(1);
}

const files = [
  'package.json',
  'src-tauri/tauri.conf.json',
];

const tag = `v${version}`;

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, stdio: 'inherit', ...options });
}

function gitOutput(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

const tagExists = (() => {
  try {
    gitOutput(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
})();

const currentVersions = files.map((rel) => {
  const filepath = resolve(root, rel);
  const json = JSON.parse(readFileSync(filepath, 'utf-8'));
  return { rel, filepath, json, old: json.version };
});

if (tagExists && currentVersions.some(({ old }) => old !== version)) {
  console.error(`tag ${tag} 已存在，但版本文件尚未全部更新到 ${version}，已停止以避免覆盖已有发布标签。`);
  process.exit(1);
}

let changed = false;

for (const { rel, filepath, json, old } of currentVersions) {
  if (old === version) {
    console.log(`⏭️  ${rel}: 已是 ${version}`);
    continue;
  }

  json.version = version;
  writeFileSync(filepath, JSON.stringify(json, null, 2) + '\n');
  console.log(`✅ ${rel}: ${old} → ${version}`);
  changed = true;
}

console.log(`\n版本检查完成: ${version}`);

execFileSync('node', [resolve(__dirname, 'verify-submodule-commits.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

if (changed) {
  git(['add', ...files]);

  try {
    git(['diff', '--cached', '--quiet', '--', ...files], { stdio: 'ignore' });
    console.log('\n版本文件没有产生 Git diff，跳过 commit。');
  } catch {
    git(['commit', '-m', `chore(version): bump version to ${tag}`]);
  }
} else {
  console.log('\n版本文件没有变化，跳过 commit。');
}

if (tagExists) {
  console.log(`🏷️  tag 已存在，跳过创建: ${tag}`);
} else {
  git(['tag', tag]);
  console.log(`🏷️  已创建 tag: ${tag}`);
}

if (autoPush) {
  git(['push']);
  git(['push', '--tags']);
  console.log(`\n🚀 已推送 commit 和 tag: ${tag}`);
} else {
  console.log(`📌 执行 git push && git push --tags 即可触发 release`);
}
