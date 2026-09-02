import { describe, expect, it } from 'vitest';
import * as vcs from '@/lib/vcs';

const author = { name: 'Tester', email: 'test@example.com' };

function seed() {
  let repo = vcs.initRepo();
  const files = { 'a.txt': 'one', 'b.txt': 'two' };
  repo = vcs.stage(repo, files);
  repo = vcs.commit(repo, 'initial', author);
  return { repo, files };
}

describe('status', () => {
  it('reports a clean tree right after a commit', () => {
    const { repo, files } = seed();
    expect(vcs.status(repo, files).clean).toBe(true);
  });

  it('classifies added, modified and deleted files', () => {
    const { repo } = seed();
    // a.txt edited, b.txt removed, c.txt new.
    const working = { 'a.txt': 'ONE', 'c.txt': 'three' };
    const status = vcs.status(repo, working);
    expect(status.unstaged).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'deleted' },
      { path: 'c.txt', status: 'added' },
    ]);
    expect(status.clean).toBe(false);
  });
});

describe('staging and committing', () => {
  it('refuses an empty commit message', () => {
    const { repo, files } = seed();
    const staged = vcs.stage(repo, { ...files, 'a.txt': 'changed' });
    expect(() => vcs.commit(staged, '   ', author)).toThrow(/message/);
  });

  it('refuses a commit with nothing staged', () => {
    const { repo } = seed();
    expect(() => vcs.commit(repo, 'nothing', author)).toThrow(/Nothing staged/);
  });

  it('stages only the paths it is given', () => {
    const { repo, files } = seed();
    const working = { ...files, 'a.txt': 'ONE', 'b.txt': 'TWO' };
    const staged = vcs.stage(repo, working, ['a.txt']);
    const status = vcs.status(staged, working);
    expect(status.staged.map((c) => c.path)).toEqual(['a.txt']);
    expect(status.unstaged.map((c) => c.path)).toEqual(['b.txt']);
  });

  it('unstage restores the index to HEAD', () => {
    const { repo, files } = seed();
    const staged = vcs.stage(repo, { ...files, 'a.txt': 'ONE' });
    const reset = vcs.unstage(staged);
    expect(vcs.status(reset, files).clean).toBe(true);
  });

  it('discard restores working files from the index', () => {
    const { repo, files } = seed();
    const restored = vcs.discard(repo, { ...files, 'a.txt': 'broken' }, ['a.txt']);
    expect(restored['a.txt']).toBe('one');
  });

  it('records history newest first', () => {
    const { repo, files } = seed();
    let next = vcs.stage(repo, { ...files, 'a.txt': 'ONE' });
    next = vcs.commit(next, 'second', author);
    const log = vcs.log(next);
    expect(log.map((c) => c.message)).toEqual(['second', 'initial']);
  });
});

describe('branches', () => {
  it('creates and lists branches', () => {
    const { repo } = seed();
    const branched = vcs.createBranch(repo, 'feature');
    expect(Object.keys(branched.branches).sort()).toEqual(['feature', 'main']);
  });

  it('rejects duplicate and malformed branch names', () => {
    const { repo } = seed();
    expect(() => vcs.createBranch(repo, 'main')).toThrow(/already exists/);
    expect(() => vcs.createBranch(repo, 'bad name!')).toThrow(/Invalid branch/);
  });

  it('refuses to delete the checked out branch', () => {
    const { repo } = seed();
    expect(Object.keys(repo.branches)).toContain('main');
    expect(() => vcs.deleteBranch(repo, 'main')).toThrow(/checked out/);
  });

  it('refuses to check out with uncommitted work', () => {
    const { repo, files } = seed();
    const branched = vcs.createBranch(repo, 'feature');
    expect(() => vcs.checkout(branched, { ...files, 'a.txt': 'dirty' }, 'feature')).toThrow(
      /uncommitted changes/,
    );
  });

  it('restores the branch snapshot on checkout', () => {
    const { repo, files } = seed();
    let next = vcs.createBranch(repo, 'feature');
    next = { ...next, head: 'feature' };
    next = vcs.stage(next, { ...files, 'c.txt': 'only on feature' });
    next = vcs.commit(next, 'add c', author);
    const back = vcs.checkout(next, { ...files, 'c.txt': 'only on feature' }, 'main');
    expect(Object.keys(back.files).sort()).toEqual(['a.txt', 'b.txt']);
  });
});

describe('merge', () => {
  it('fast-forwards when the target is ahead', () => {
    const { repo, files } = seed();
    let next = vcs.createBranch(repo, 'feature');
    next = { ...next, head: 'feature' };
    next = vcs.stage(next, { ...files, 'c.txt': 'new' });
    next = vcs.commit(next, 'add c', author);
    next = { ...next, head: 'main', index: { ...next.commits[next.branches.main].tree } };

    const outcome = vcs.merge(next, files, 'feature', author);
    expect(outcome.fastForward).toBe(true);
    expect(Object.keys(outcome.files).sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('merges divergent branches that touch different files', () => {
    const { repo, files } = seed();
    let feature = vcs.createBranch(repo, 'feature');
    feature = { ...feature, head: 'feature' };
    const featureFiles = { ...files, 'b.txt': 'two-feature' };
    feature = vcs.stage(feature, featureFiles);
    feature = vcs.commit(feature, 'edit b', author);

    let main = { ...feature, head: 'main', index: { ...feature.commits[feature.branches.main].tree } };
    const mainFiles = { ...files, 'a.txt': 'one-main' };
    main = vcs.stage(main, mainFiles);
    main = vcs.commit(main, 'edit a', author);

    const outcome = vcs.merge(main, mainFiles, 'feature', author);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.files['a.txt']).toBe('one-main');
    expect(outcome.files['b.txt']).toBe('two-feature');
    expect(vcs.log(outcome.repo)[0].parents).toHaveLength(2);
  });

  it('reports conflicts when both branches changed the same file', () => {
    const { repo, files } = seed();
    let feature = vcs.createBranch(repo, 'feature');
    feature = { ...feature, head: 'feature' };
    const featureFiles = { ...files, 'a.txt': 'feature version' };
    feature = vcs.commit(vcs.stage(feature, featureFiles), 'feature edit', author);

    let main = { ...feature, head: 'main', index: { ...feature.commits[feature.branches.main].tree } };
    const mainFiles = { ...files, 'a.txt': 'main version' };
    main = vcs.commit(vcs.stage(main, mainFiles), 'main edit', author);

    const outcome = vcs.merge(main, mainFiles, 'feature', author);
    expect(outcome.conflicts).toEqual(['a.txt']);
    expect(outcome.files['a.txt']).toContain('<<<<<<< ours');
  });

  it('reports already up to date when nothing to bring in', () => {
    const { repo, files } = seed();
    const branched = vcs.createBranch(repo, 'feature');
    const outcome = vcs.merge(branched, files, 'feature', author);
    expect(outcome.alreadyUpToDate).toBe(true);
  });

  it('refuses to merge a branch into itself', () => {
    const { repo, files } = seed();
    expect(() => vcs.merge(repo, files, 'main', author)).toThrow(/into itself/);
  });
});

describe('guards', () => {
  it('refuses to commit to an uninitialized repository', () => {
    expect(() => vcs.commit(vcs.emptyRepo(), 'x', author)).toThrow(/not initialized/);
  });

  it('hashes content deterministically and distinguishes different content', () => {
    expect(vcs.hashContent('abc')).toBe(vcs.hashContent('abc'));
    expect(vcs.hashContent('abc')).not.toBe(vcs.hashContent('abd'));
  });
});
