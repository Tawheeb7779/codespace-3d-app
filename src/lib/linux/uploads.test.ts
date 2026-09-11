import { describe, expect, it } from 'vitest';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  UPLOAD_DIR,
  describeTransfer,
  looksBinary,
  planUpload,
  planUploads,
  projectPathFor,
  uploadPathFor,
} from '@/lib/linux/uploads';

/**
 * Putting a file into the Linux workspace, and the separation that must hold.
 *
 * Two properties. An upload lands inside the upload directory and cannot be
 * talked out of it by its own name — the gateway checks again, but a path that
 * escapes here would be a bug on the near side of a boundary, and the near side
 * is where it is cheap to catch.
 *
 * And a file that would not survive the crossing is refused rather than sent. A
 * binary pushed down a channel that carries strings arrives corrupted and looks
 * like it worked, which is the failure a person discovers much later, holding a
 * file that is no longer the file.
 */

describe('naming an upload', () => {
  it('puts it in the upload directory', () => {
    expect(uploadPathFor('notes.md')).toBe(`${UPLOAD_DIR}/notes.md`);
  });

  /** A name is not a path here: every separator is dropped, not resolved. */
  it.each([
    ['../../etc/passwd', `${UPLOAD_DIR}/passwd`],
    ['/etc/hosts', `${UPLOAD_DIR}/hosts`],
    ['C:\\Windows\\win.ini', `${UPLOAD_DIR}/win.ini`],
    ['sub/dir/file.txt', `${UPLOAD_DIR}/file.txt`],
  ])('flattens %s', (name, expected) => {
    expect(uploadPathFor(name)).toBe(expected);
  });

  it('never returns a path outside the upload directory', () => {
    for (const name of ['..', '.', '....//..', '~/.bashrc', '.env']) {
      const path = uploadPathFor(name);
      if (path === null) continue;
      expect(path.startsWith(`${UPLOAD_DIR}/`)).toBe(true);
      expect(path).not.toContain('..');
    }
  });

  it('replaces characters a shell would read as syntax', () => {
    expect(uploadPathFor('my file;rm -rf.txt')).toBe(`${UPLOAD_DIR}/my-file-rm--rf.txt`);
  });

  it('refuses a name with nothing usable left', () => {
    expect(uploadPathFor('...')).toBeNull();
    expect(uploadPathFor('')).toBeNull();
  });

  it('bounds the length', () => {
    const path = uploadPathFor(`${'a'.repeat(500)}.txt`);

    expect(path!.length).toBeLessThan(UPLOAD_DIR.length + 130);
  });
});

describe('deciding what can cross', () => {
  it('accepts a text file', () => {
    const plan = planUpload({ name: 'a.txt', content: 'hello\n', size: 6 });

    expect(plan).toEqual({ ok: true, path: `${UPLOAD_DIR}/a.txt`, content: 'hello\n' });
  });

  /** A NUL byte or a replacement character means the read already lost data. */
  it.each([
    ['a NUL byte', 'PK\u0000\u0000'],
    ['a replacement character', 'caf\uFFFD'],
  ])('refuses %s as binary', (_label, content) => {
    expect(looksBinary(content)).toBe(true);

    const plan = planUpload({ name: 'a.bin', content, size: content.length });

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/binary/i);
    expect(!plan.ok && plan.reason).toMatch(/curl or git/i);
  });

  it('does not call ordinary text binary', () => {
    expect(looksBinary('const x = 1;\nconst é = "ok";\n')).toBe(false);
  });

  it('refuses a file over the channel’s limit, and says the limit', () => {
    const plan = planUpload({ name: 'big.txt', content: 'x', size: MAX_UPLOAD_BYTES + 1 });

    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toMatch(/limit on the sync channel/i);
  });

  it('accepts a file exactly at the limit', () => {
    expect(planUpload({ name: 'edge.txt', content: 'x', size: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });
});

describe('a batch of uploads', () => {
  it('sends the ones that can cross and reports the ones that cannot', () => {
    const { push, outcome } = planUploads([
      { name: 'good.txt', content: 'ok', size: 2 },
      { name: 'bad.bin', content: '\u0000', size: 1 },
    ]);

    expect(push).toEqual([{ path: `${UPLOAD_DIR}/good.txt`, content: 'ok' }]);
    expect(outcome.uploaded).toEqual([{ path: `${UPLOAD_DIR}/good.txt`, size: 2 }]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0].name).toBe('bad.bin');
  });

  /** Refusing the overflow beats silently dropping it. */
  it('bounds one batch and names what did not fit', () => {
    const many = Array.from({ length: MAX_UPLOAD_FILES + 3 }, (_, index) => ({
      name: `f${index}.txt`,
      content: 'x',
      size: 1,
    }));
    const { push, outcome } = planUploads(many);

    expect(push).toHaveLength(MAX_UPLOAD_FILES);
    expect(outcome.refused).toHaveLength(3);
    expect(outcome.refused[0].reason).toMatch(/at once/i);
  });
});

describe('where a transferred file lands', () => {
  /** The gateway resolves the same relative path on both sides. */
  it('is the same path in the project', () => {
    expect(projectPathFor(`${UPLOAD_DIR}/notes.md`)).toBe(`${UPLOAD_DIR}/notes.md`);
  });
});

describe('describing what a transfer did', () => {
  it('counts what was copied', () => {
    expect(describeTransfer({ copied: ['uploads/a', 'uploads/b'], conflicts: [], skipped: [] })).toContain(
      'Copied 2 files',
    );
  });

  it('says plainly when nothing was copied', () => {
    expect(describeTransfer({ copied: [], conflicts: [], skipped: [] })).toContain(
      'Nothing was copied',
    );
  });

  /**
   * The wording that matters: a conflict means the project still holds the old
   * file, and a summary reading "copied" would leave somebody certain they have
   * the new one.
   */
  it('says a conflicting file was left alone, and names it', () => {
    const text = describeTransfer({
      copied: [],
      conflicts: ['uploads/notes.md'],
      skipped: [],
    });

    expect(text).toMatch(/left as they were/i);
    expect(text).toContain('uploads/notes.md');
    expect(text).not.toMatch(/^Copied/);
  });

  it('repeats the gateway’s reason for a refusal', () => {
    const text = describeTransfer({
      copied: [],
      conflicts: [],
      skipped: [{ path: 'uploads/huge', reason: 'too large' }],
    });

    expect(text).toContain('uploads/huge was refused: too large');
  });
});
