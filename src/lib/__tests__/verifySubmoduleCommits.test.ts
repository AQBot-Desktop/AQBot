import { describe, expect, it } from 'vitest';

const verifyModule =
  // @ts-expect-error The workflow helper is native ESM without TypeScript declarations.
  await import('../../../scripts/verify-submodule-commits.mjs');
const { gitlinkCommits, githubRepoFromUrl, missingSubmoduleCommits, parseGitmodules } =
  verifyModule;

describe('submodule commit verification', () => {
  it('parses gitlinks and GitHub submodule URLs', () => {
    expect(
      gitlinkCommits('160000 commit 12140844418d749fd7059ec4622b203e6b7f181a\tsrc-tauri/crates/open-agent-sdk'),
    ).toEqual([
      {
        sha: '12140844418d749fd7059ec4622b203e6b7f181a',
        path: 'src-tauri/crates/open-agent-sdk',
      },
    ]);
    expect(githubRepoFromUrl('git@github.com:AQBot-Desktop/open-agent-sdk-rust.git')).toBe(
      'AQBot-Desktop/open-agent-sdk-rust',
    );
    expect(parseGitmodules(`[submodule "src-tauri/crates/open-agent-sdk"]
	path = src-tauri/crates/open-agent-sdk
	url = git@github.com:AQBot-Desktop/open-agent-sdk-rust.git
`).map(({ path, url }: { path: string; url: string }) => ({ path, url }))).toEqual([
      {
        path: 'src-tauri/crates/open-agent-sdk',
        url: 'git@github.com:AQBot-Desktop/open-agent-sdk-rust.git',
      },
    ]);
  });

  it('fails when a gitlink SHA is not on the submodule remote', () => {
    const missing = missingSubmoduleCommits({
      gitmodules: `[submodule "sdk"]
	path = src-tauri/crates/open-agent-sdk
	url = git@github.com:AQBot-Desktop/open-agent-sdk-rust.git
`,
      lsTree: '160000 commit 12140844418d749fd7059ec4622b203e6b7f181a\tsrc-tauri/crates/open-agent-sdk',
      exists: () => false,
    });
    expect(missing).toEqual([
      {
        path: 'src-tauri/crates/open-agent-sdk',
        sha: '12140844418d749fd7059ec4622b203e6b7f181a',
        repo: 'AQBot-Desktop/open-agent-sdk-rust',
        reason: 'not on AQBot-Desktop/open-agent-sdk-rust',
      },
    ]);
  });
});
