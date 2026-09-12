import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentStore } from '@/stores/agentStore';
import { useFileStore } from '@/stores/fileStore';
import { outcomeFor } from '@/lib/ai/validation';

/**
 * Evidence must expire when the *user* edits, not only when the agent does.
 *
 * The agent's own writes go through `noteChange`, which bumps the validation
 * revision. A person typing in the editor goes through `fileStore.writeFile`
 * and touches nothing — so a check taken before they typed stays "current",
 * and the task ends `completed` on evidence that predates their change.
 *
 * That is the shape this whole module exists to prevent, arriving through the
 * one door that was left open: every step succeeded, a real check really did
 * pass, and it passed against code the user has since changed.
 */

beforeEach(() => {
  /*
   * `finish` first, not just a state reset.
   *
   * The store holds a module-level project lock so two agents cannot edit one
   * workspace; only `finish` releases it. Resetting `task` to null leaves the
   * lock held, the next `begin` returns null, and the test that follows silently
   * runs with no task at all — passing or failing for the wrong reason.
   */
  useAgentStore.getState().finish('cancelled');
  useAgentStore.setState({ task: null, history: [], pending: null, lockedProjectId: null });
  useFileStore.setState({
    projectId: 'proj-1',
    files: { 'src/a.ts': 'export const a = 1;\n' },
    dirs: [],
    dirty: new Set<string>(),
    // Writable, or every write throws before reaching the point under test.
    role: 'owner',
  } as never);
});

function taskWithPassingCheck() {
  const agent = useAgentStore.getState();
  agent.begin('do the thing', 'proj-1');
  agent.noteChange('src/a.ts', 'modified', 'export const a = 1;\n', 'export const a = 2;\n');
  agent.noteVerification({ name: 'test', ok: true, detail: 'exit 0', ran: true });
}

describe('a user edit during a task', () => {
  it('is recorded as invalidating the evidence', () => {
    taskWithPassingCheck();
    const before = useAgentStore.getState().validation.revision;

    useFileStore.getState().writeFile('src/a.ts', 'the user typed this\n');

    expect(useAgentStore.getState().validation.revision).toBeGreaterThan(before);
  });

  /** The outcome that must not be reachable: completed on stale evidence. */
  it('stops the task reporting completed on evidence that predates it', () => {
    taskWithPassingCheck();

    useFileStore.getState().writeFile('src/a.ts', 'the user typed this\n');

    const outcome = outcomeFor({
      state: useAgentStore.getState().validation,
      verificationEnabled: true,
      changedFiles: 1,
    });

    expect(outcome).toBe('unverified');
  });

  it('leaves the outcome completed when nobody edited after the check', () => {
    taskWithPassingCheck();

    const outcome = outcomeFor({
      state: useAgentStore.getState().validation,
      verificationEnabled: true,
      changedFiles: 1,
    });

    expect(outcome).toBe('completed');
  });

  it('does nothing when no task is running', () => {
    useFileStore.getState().writeFile('src/a.ts', 'idle edit\n');

    expect(useAgentStore.getState().task).toBeNull();
  });

  /** Creating and deleting move the files too, so they invalidate as well. */
  it('invalidates on a file the user creates', () => {
    taskWithPassingCheck();
    const before = useAgentStore.getState().validation.revision;

    useFileStore.getState().createFile('src/b.ts', 'export const b = 1;\n');

    expect(useAgentStore.getState().validation.revision).toBeGreaterThan(before);
  });
});
