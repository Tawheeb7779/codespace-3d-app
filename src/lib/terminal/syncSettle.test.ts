import { beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceSync } from '@/lib/terminal/workspaceSync';

/**
 * Knowing that the container holds what the editor wrote.
 *
 * This exists for one caller: the agent, about to run the project's real tests
 * in the container. Between a write in the editor and the file existing over
 * there sits a debounce, a push and an acknowledgement — and a check started
 * inside that window runs against the previous files and passes.
 *
 * That is the worst shape this failure can take. Every step succeeded. The
 * tests really did pass. The conclusion is still wrong, and nobody has any
 * reason to look.
 *
 * So every way of not-settling is a failure, and each is distinguishable,
 * because "your file was too large" and "the container never answered" send a
 * person to different places.
 */

interface Pushed {
  path: string;
  content: string;
  baseHash?: string;
}

let pushed: Pushed[][];
let manifests: unknown[];
let conflicts: unknown[];

function build(files: Record<string, string>) {
  pushed = [];
  manifests = [];
  conflicts = [];
  return new WorkspaceSync({
    terminal: {
      sendManifest: (entries) => manifests.push(entries),
      pushFiles: (entries) => pushed.push(entries as Pushed[]),
      deleteFiles: () => undefined,
      get containerId() {
        return 'container-1';
      },
    },
    files: () => files,
    applyFromContainer: () => undefined,
    onConflict: (conflict) => conflicts.push(conflict),
    debounceMs: 0,
  });
}

beforeEach(() => {
  pushed = [];
  manifests = [];
  conflicts = [];
});

/**
 * Wait until the push has actually left, rather than guessing at a delay.
 *
 * `settle()` awaits an async flush — SHA-256 over each file — before it records
 * what is outstanding and calls `pushFiles`. A test that acks after a fixed
 * sleep is racing that hash: under load the ack arrives first, deletes nothing,
 * and the flush then marks the file outstanding forever.
 *
 * Production cannot hit this, because the gateway only acks in response to
 * `pushFiles`, and the engine records the file synchronously immediately before
 * calling it. Waiting for the push here asserts that same precondition instead
 * of assuming it.
 */
async function untilPushed(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (pushed.length) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the sync engine never pushed anything');
}

/** Get the engine into the started state with one file pushed and waiting. */
async function withPendingPush() {
  const files = { 'src/a.ts': 'export const a = 1;\n' };
  const sync = build(files);
  await sync.start();
  await sync.onPlan({ needed: ['src/a.ts'], diverged: [], skipped: [] });
  return sync;
}

describe('a sync that has settled', () => {
  it('reports ok once every push is acknowledged', async () => {
    const sync = await withPendingPush();
    const settling = sync.settle(2_000);

    // The gateway confirms what was sent.
    await untilPushed();
    sync.onAck([{ status: 'written', path: 'src/a.ts', hash: 'h1' }]);

    await expect(settling).resolves.toEqual({ ok: true });
  });

  it('reports ok immediately when there is nothing to send', async () => {
    const sync = build({});
    await sync.start();

    await expect(sync.settle(2_000)).resolves.toEqual({ ok: true });
  });
});

describe('every way of not settling is a failure', () => {
  /** The container holds a different version; the tests would test that one. */
  it('reports a conflict rather than letting a check proceed', async () => {
    const sync = await withPendingPush();
    const settling = sync.settle(2_000);

    await untilPushed();
    sync.onAck([
      { status: 'conflict', path: 'src/a.ts', containerHash: 'h2', editorHash: 'h1' },
    ]);

    const result = await settling;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('conflict');
    expect(result.ok === false && result.detail).toMatch(/not testing the same file/i);
  });

  /** The file never arrived, so what is over there is missing the change. */
  it('reports a skipped file', async () => {
    const sync = await withPendingPush();
    const settling = sync.settle(2_000);

    await untilPushed();
    sync.onAck([{ status: 'skipped', path: 'src/a.ts', reason: 'file too large' }]);

    const result = await settling;
    expect(result.ok === false && result.reason).toBe('skipped');
    expect(result.ok === false && result.detail).toMatch(/file too large/);
  });

  it('reports a disconnect', async () => {
    const sync = build({});

    const result = await sync.settle(2_000);
    expect(result.ok === false && result.reason).toBe('disconnected');
  });

  /** Silence is not agreement. */
  it('reports a timeout when nothing comes back', async () => {
    const sync = await withPendingPush();

    const result = await sync.settle(120);
    expect(result.ok === false && result.reason).toBe('timeout');
    expect(result.ok === false && result.detail).toMatch(/did not confirm/i);
  });

  it('says how many files were unconfirmed', async () => {
    const sync = await withPendingPush();

    const result = await sync.settle(120);
    expect(result.ok === false && result.detail).toMatch(/1 file/);
  });
});

describe('a recorded problem', () => {
  it('is reported again until it is cleared', async () => {
    const sync = await withPendingPush();
    const settling = sync.settle(2_000);
    await untilPushed();
    sync.onAck([{ status: 'skipped', path: 'src/a.ts', reason: 'too large' }]);
    await settling;

    const second = await sync.settle(2_000);
    expect(second.ok).toBe(false);
  });

  it('stops being reported once cleared', async () => {
    const sync = await withPendingPush();
    const settling = sync.settle(2_000);
    await untilPushed();
    sync.onAck([{ status: 'skipped', path: 'src/a.ts', reason: 'too large' }]);
    await settling;

    sync.clearTrouble();
    await expect(sync.settle(2_000)).resolves.toEqual({ ok: true });
  });
});

describe('settling pushes what is waiting', () => {
  /** Waiting out a debounce would make every check slower for no reason. */
  it('flushes rather than waiting for the debounce', async () => {
    const files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' };
    const sync = build(files);
    await sync.start();
    await sync.onPlan({ needed: ['src/a.ts'], diverged: [], skipped: [] });

    const settling = sync.settle(300);
    await untilPushed();

    expect(pushed.flat().map((entry) => entry.path)).toContain('src/a.ts');
    sync.onAck([{ status: 'written', path: 'src/a.ts', hash: 'h1' }]);
    await settling;
  });
});
