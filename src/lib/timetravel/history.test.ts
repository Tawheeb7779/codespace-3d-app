import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_SNAPSHOTS,
  captureSnapshot,
  diffAgainst,
  divergencePrompt,
  planRestore,
  trimHistory,
  type Snapshot,
} from '@/lib/timetravel/history';
import { useTimeTravelStore } from '@/stores/timeTravelStore';

/**
 * Going back, and the two things that must not be quietly wrong.
 *
 * A restore overwrites somebody's work. So what it will do has to be computed
 * and shown before it does it — including the files it *cannot* restore because
 * they were too large to record. A restore that silently left a file at its
 * current version while reporting success is the failure this guards: it looks
 * exactly like a restore that worked.
 *
 * And the recording has to stay bounded. A copy of the project per keystroke is
 * how a recorder becomes the reason the editor is slow.
 */

const snapshotOf = (files: Record<string, string>, id = 's1', at = 1_000): Snapshot =>
  captureSnapshot(files, 'manual', 'test', id, at);

describe('taking a snapshot', () => {
  it('keeps the files as they were', () => {
    const snapshot = snapshotOf({ 'a.ts': 'one', 'b.ts': 'two' });

    expect(snapshot.files).toEqual({ 'a.ts': 'one', 'b.ts': 'two' });
    expect(snapshot.skipped).toEqual([]);
  });

  /** Named, so the gap is visible rather than mistaken for "unchanged". */
  it('names a file too large to record instead of dropping it silently', () => {
    const snapshot = snapshotOf({ 'big.js': 'x'.repeat(MAX_FILE_BYTES + 1), 'a.ts': 'ok' });

    expect(snapshot.skipped).toEqual(['big.js']);
    expect(snapshot.files).toEqual({ 'a.ts': 'ok' });
  });

  it('reports the bytes it holds', () => {
    expect(snapshotOf({ 'a.ts': 'hello' }).bytes).toBeGreaterThan(0);
  });
});

describe('bounding the history', () => {
  it('keeps only the most recent points', () => {
    const many = Array.from({ length: MAX_SNAPSHOTS + 5 }, (_, index) =>
      snapshotOf({ 'a.ts': `v${index}` }, `s${index}`, index),
    );

    const kept = trimHistory(many);

    expect(kept).toHaveLength(MAX_SNAPSHOTS);
    // Newest first, so the oldest were the ones dropped.
    expect(kept[0].id).toBe(`s${MAX_SNAPSHOTS + 4}`);
  });

  it('drops the oldest when the total grows too large', () => {
    const heavy = Array.from({ length: 6 }, (_, index) => ({
      ...snapshotOf({ 'a.ts': 'x' }, `s${index}`, index),
      bytes: 3 * 1024 * 1024,
    }));

    const kept = trimHistory(heavy);

    expect(kept.length).toBeLessThan(6);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('never drops the last one, however large', () => {
    const huge = [{ ...snapshotOf({ 'a.ts': 'x' }), bytes: 500 * 1024 * 1024 }];

    expect(trimHistory(huge)).toHaveLength(1);
  });
});

describe('comparing with now', () => {
  it('reports what was added, removed and changed', () => {
    const snapshot = snapshotOf({ 'kept.ts': 'same', 'gone.ts': 'x', 'edited.ts': 'before' });

    const { changes } = diffAgainst(snapshot, {
      'kept.ts': 'same',
      'edited.ts': 'after',
      'new.ts': 'y',
    });

    expect(changes).toEqual([
      { path: 'edited.ts', kind: 'changed' },
      { path: 'gone.ts', kind: 'removed' },
      { path: 'new.ts', kind: 'added' },
    ]);
  });

  /** There is no recorded version, so "unchanged" is an answer this lacks. */
  it('does not claim a file it never recorded is unchanged', () => {
    const snapshot = snapshotOf({ 'big.js': 'x'.repeat(MAX_FILE_BYTES + 1), 'a.ts': 'v1' });

    const { changes, unknown } = diffAgainst(snapshot, { 'big.js': 'totally different', 'a.ts': 'v1' });

    expect(changes).toEqual([]);
    expect(unknown).toEqual(['big.js']);
  });

  it('reports nothing when the project is untouched', () => {
    const snapshot = snapshotOf({ 'a.ts': 'same' });

    expect(diffAgainst(snapshot, { 'a.ts': 'same' }).changes).toEqual([]);
  });
});

describe('what a restore would do', () => {
  it('lists the files it would write back', () => {
    const snapshot = snapshotOf({ 'a.ts': 'before', 'b.ts': 'same' });

    const plan = planRestore(snapshot, { 'a.ts': 'after', 'b.ts': 'same' });

    expect(plan.willWrite).toEqual(['a.ts']);
  });

  /** Deleting work is the part somebody must see before agreeing to it. */
  it('lists the files created since, which it would delete', () => {
    const snapshot = snapshotOf({ 'a.ts': 'x' });

    const plan = planRestore(snapshot, { 'a.ts': 'x', 'new.ts': 'created since' });

    expect(plan.willDelete).toEqual(['new.ts']);
  });

  /**
   * The quiet failure this exists to prevent: a file that keeps its current
   * contents while the restore reports success.
   */
  it('names the files it cannot restore rather than reporting a clean restore', () => {
    const snapshot = snapshotOf({ 'big.js': 'x'.repeat(MAX_FILE_BYTES + 1), 'a.ts': 'v1' });

    const plan = planRestore(snapshot, { 'big.js': 'changed since', 'a.ts': 'v2' });

    expect(plan.cannotRestore).toEqual(['big.js']);
    expect(plan.willDelete).not.toContain('big.js');
    expect(plan.willWrite).toEqual(['a.ts']);
  });

  it('writes nothing when the project already matches', () => {
    const snapshot = snapshotOf({ 'a.ts': 'same' });

    const plan = planRestore(snapshot, { 'a.ts': 'same' });

    expect(plan.willWrite).toEqual([]);
    expect(plan.willDelete).toEqual([]);
  });
});

describe('asking what broke', () => {
  it('carries the changed files and the recorded events', () => {
    const snapshot = snapshotOf({ 'a.ts': 'before' });
    const prompt = divergencePrompt(
      snapshot,
      [{ path: 'a.ts', kind: 'changed' }],
      [{ source: 'preview', title: 'TypeError: x is not a function' }],
    );

    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('TypeError');
  });

  /** A confident wrong answer sends somebody down the wrong path for an afternoon. */
  it('tells the agent to say when the record is not enough', () => {
    const prompt = divergencePrompt(snapshotOf({}), [], []);

    expect(prompt).toMatch(/not enough to tell, say so/i);
    expect(prompt).toMatch(/rather than\s+naming a cause that merely fits/i);
  });

  it('says plainly when no events were recorded', () => {
    const prompt = divergencePrompt(snapshotOf({}), [{ path: 'a.ts', kind: 'changed' }], []);

    expect(prompt).toMatch(/No events were recorded/i);
  });
});

describe('the store', () => {
  beforeEach(() => {
    useTimeTravelStore.setState({ snapshots: [], restoring: false });
  });

  it('records a point', () => {
    const id = useTimeTravelStore.getState().capture({ 'a.ts': 'x' }, 'manual', 'by hand');

    expect(id).toBeTruthy();
    expect(useTimeTravelStore.getState().snapshots).toHaveLength(1);
  });

  it('records nothing for an empty project', () => {
    expect(useTimeTravelStore.getState().capture({}, 'manual', 'nothing')).toBeNull();
  });

  /**
   * Builds fire in quick succession while somebody types. Without this the
   * history fills with near-identical copies and the useful older points are
   * pushed out.
   */
  it('does not take two points for the same reason in quick succession', () => {
    useTimeTravelStore.getState().capture({ 'a.ts': 'x' }, 'build', 'first');

    const second = useTimeTravelStore.getState().capture({ 'a.ts': 'y' }, 'build', 'second');

    expect(second).toBeNull();
    expect(useTimeTravelStore.getState().snapshots).toHaveLength(1);
  });

  it('still records a different kind of point immediately', () => {
    useTimeTravelStore.getState().capture({ 'a.ts': 'x' }, 'build', 'a build');

    const second = useTimeTravelStore.getState().capture({ 'a.ts': 'y' }, 'commit', 'a commit');

    expect(second).toBeTruthy();
    expect(useTimeTravelStore.getState().snapshots).toHaveLength(2);
  });

  it('keeps the newest first', () => {
    useTimeTravelStore.getState().capture({ 'a.ts': 'x' }, 'commit', 'older');
    useTimeTravelStore.getState().capture({ 'a.ts': 'y' }, 'manual', 'newer');

    expect(useTimeTravelStore.getState().snapshots[0].label).toBe('newer');
  });

  it('forgets one point without touching the others', () => {
    const first = useTimeTravelStore.getState().capture({ 'a.ts': 'x' }, 'commit', 'one')!;
    useTimeTravelStore.getState().capture({ 'a.ts': 'y' }, 'manual', 'two');

    useTimeTravelStore.getState().remove(first);

    expect(useTimeTravelStore.getState().snapshots).toHaveLength(1);
    expect(useTimeTravelStore.getState().find(first)).toBeNull();
  });

  /**
   * A snapshot is a copy of somebody's source; writing it to browser storage
   * would leave the project sitting there after the tab closed.
   */
  it('does not write the project to browser storage', () => {
    useTimeTravelStore.getState().capture({ 'secret.ts': 'const key = "abc";' }, 'manual', 'x');

    const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? '').join('');
    expect(stored).not.toContain('const key = "abc"');
  });
});
