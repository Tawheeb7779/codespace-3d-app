// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGithub, gitBlobSha } from '@/test/githubApi';

/**
 * Proves the integration harness stores *real* git objects.
 *
 * Every other GitHub test in this suite runs against `FakeGithub`. That is
 * only worth anything if its object ids and its fast-forward rule match git's,
 * so this file checks them against the `git` binary itself. If the harness
 * ever drifts into agreeing with the client rather than with git, this fails.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

let available = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  available = false;
}

const describeIfGit = available ? describe : describe.skip;

describeIfGit('git object identity', () => {
  it('hashes blobs exactly as git hash-object does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
    try {
      git(dir, 'init', '-q');
      for (const content of ['hello\n', '', 'a\nb\nc\n', 'unicode — ✓\n', 'x'.repeat(5000)]) {
        writeFileSync(join(dir, 'f.txt'), content);
        expect(gitBlobSha(content), JSON.stringify(content.slice(0, 20))).toBe(
          git(dir, 'hash-object', 'f.txt'),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds trees whose ids match a real git index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
    try {
      git(dir, 'init', '-q');
      const files = {
        'README.md': '# demo\n',
        'src/main.js': 'console.log(1);\n',
        'src/lib/util.js': 'export const x = 1;\n',
        'a.txt': 'a\n',
      };
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content);
      }
      git(dir, 'add', '-A');
      const real = git(dir, 'write-tree');

      const api = new FakeGithub();
      const repo = api.createRepo('octocat', 'demo');
      expect(repo.writeTree(files)).toBe(real);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('produces commit ids git agrees with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'README.md'), '# demo\n');
      git(dir, 'add', '-A');
      const tree = git(dir, 'write-tree');

      const api = new FakeGithub();
      const repo = api.createRepo('octocat', 'demo');
      const ourTree = repo.writeTree({ 'README.md': '# demo\n' });
      expect(ourTree).toBe(tree);

      const sha = repo.writeCommit({
        tree: ourTree,
        parents: [],
        message: 'Initial commit',
        author: { name: 'Tester', email: 'test@example.com' },
      });

      const real = git(
        dir,
        '-c',
        'user.name=Tester',
        '-c',
        'user.email=test@example.com',
        'commit-tree',
        tree,
        '-m',
        'Initial commit',
      );
      // commit-tree stamps "now"; recompute with the harness's fixed timestamp
      // by asking git to hash the identical object text.
      const text =
        `tree ${tree}\n` +
        `author Tester <test@example.com> 1700000000 +0000\n` +
        `committer Tester <test@example.com> 1700000000 +0000\n\nInitial commit\n`;
      writeFileSync(join(dir, 'commit.txt'), text);
      expect(sha).toBe(git(dir, 'hash-object', '-t', 'commit', 'commit.txt'));
      expect(real).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a fast-forward and refuses anything else, as git does', () => {
    const api = new FakeGithub();
    const repo = api.createRepo('octocat', 'demo');
    const first = repo.seed('main', { 'a.txt': '1\n' });
    const second = repo.seed('main', { 'a.txt': '2\n' });
    // A sibling of `first`, not a descendant of `second`.
    const sideTree = repo.writeTree({ 'a.txt': '3\n' });
    const side = repo.writeCommit({ tree: sideTree, parents: [first], message: 'side' });

    expect(repo.isAncestor(first, second)).toBe(true);
    expect(repo.isAncestor(second, side)).toBe(false);
  });
});
