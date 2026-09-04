#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseGitmodules(text) {
  const modules = [];
  let current = null;
  for (const line of text.split('\n')) {
    const name = line.match(/^\[submodule "(.+)"\]\s*$/);
    if (name) {
      if (current) modules.push(current);
      current = { name: name[1] };
      continue;
    }
    const kv = line.match(/^\s*(path|url)\s*=\s*(.+?)\s*$/);
    if (kv && current) current[kv[1]] = kv[2];
  }
  if (current) modules.push(current);
  return modules;
}

export function githubRepoFromUrl(url) {
  const match = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`unsupported submodule url: ${url}`);
  return match[1];
}

export function gitlinkCommits(lsTree) {
  return lsTree
    .split('\n')
    .map((line) => line.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/))
    .filter(Boolean)
    .map((match) => ({ sha: match[1], path: match[2] }));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitExistsOnGitHub(repo, sha) {
  try {
    execFileSync('gh', ['api', `repos/${repo}/commits/${sha}`, '-q', '.sha'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function missingSubmoduleCommits({ gitmodules, lsTree, exists = commitExistsOnGitHub }) {
  const modules = parseGitmodules(gitmodules);
  const missing = [];
  for (const { sha, path } of gitlinkCommits(lsTree)) {
    const module = modules.find((entry) => entry.path === path);
    if (!module?.url) {
      missing.push({ path, sha, reason: 'no .gitmodules url' });
      continue;
    }
    const repo = githubRepoFromUrl(module.url);
    if (!exists(repo, sha)) {
      missing.push({ path, sha, repo, reason: `not on ${repo}` });
    }
  }
  return missing;
}

function main() {
  const root = process.cwd();
  const missing = missingSubmoduleCommits({
    gitmodules: readFileSync(resolve(root, '.gitmodules'), 'utf8'),
    lsTree: git(['ls-tree', '-r', 'HEAD'], root),
  });
  if (missing.length === 0) {
    console.log('All submodule commits exist on their remotes');
    return;
  }
  for (const item of missing) {
    console.error(`❌ ${item.path} ${item.sha} ${item.reason}; push the submodule before tagging`);
  }
  process.exitCode = 1;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main();
}
