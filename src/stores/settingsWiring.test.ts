import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { initRepo } from '@/lib/vcs';
import { systemPrompt } from '@/lib/ai/agent';
import { classify, WIDE_CHANGE_THRESHOLD } from '@/lib/ai/approval';

/**
 * Settings that actually do something.
 *
 * A preference the product stores but never reads is a fake feature. Each of
 * these asserts the setting reaches the code that acts on it, rather than
 * asserting only that it round-trips through the store.
 */

beforeEach(() => {
  useSettingsStore.getState().resetAll();
  useTerminalStore.setState({ sessions: [], activeId: null });
});

describe('terminal settings', () => {
  it('drops the banner from a new session when turned off', () => {
    const withBanner = useTerminalStore.getState().createSession();
    expect(
      useTerminalStore.getState().sessions.find((s) => s.id === withBanner)?.lines.length,
    ).toBeGreaterThan(0);

    useSettingsStore.getState().setTerminal({ showBanner: false });
    const bare = useTerminalStore.getState().createSession();
    expect(useTerminalStore.getState().sessions.find((s) => s.id === bare)?.lines).toEqual([]);
  });

  it('keeps scrollback to the configured number of lines', () => {
    useSettingsStore.getState().setTerminal({ scrollback: 250, showBanner: false });
    const id = useTerminalStore.getState().createSession();
    useTerminalStore
      .getState()
      .append(id, Array.from({ length: 400 }, (_, i) => ({ kind: 'stdout' as const, text: `${i}` })));

    const lines = useTerminalStore.getState().sessions.find((s) => s.id === id)?.lines ?? [];
    expect(lines).toHaveLength(250);
    // The newest output is what survives, not the oldest.
    expect(lines[lines.length - 1].text).toBe('399');
  });

  /** A pathological value must not be able to exhaust memory. */
  it('clamps an absurd scrollback setting', () => {
    useSettingsStore.getState().setTerminal({ scrollback: 5, showBanner: false });
    const id = useTerminalStore.getState().createSession();
    useTerminalStore
      .getState()
      .append(id, Array.from({ length: 400 }, (_, i) => ({ kind: 'stdout' as const, text: `${i}` })));
    expect(
      useTerminalStore.getState().sessions.find((s) => s.id === id)?.lines.length,
    ).toBeGreaterThanOrEqual(200);
  });
});

describe('source control settings', () => {
  it('starts a new repository on the configured branch', () => {
    expect(initRepo('main').head).toBe('main');
    const repo = initRepo('trunk');
    expect(repo.head).toBe('trunk');
    expect(Object.keys(repo.branches)).toEqual(['trunk']);
  });

  it('falls back to main rather than a nameless branch', () => {
    expect(initRepo('   ').head).toBe('main');
    expect(initRepo().head).toBe('main');
  });
});

describe('assistant settings', () => {
  it('asks the agent to verify, and says so plainly when it should not', () => {
    expect(systemPrompt(true)).toMatch(/call run_build/);
    const relaxed = systemPrompt(false);
    expect(relaxed).not.toMatch(/Verify your work/);
    // Turning verification off never licenses an unearned claim.
    expect(relaxed).toMatch(/do not claim it builds or passes when you have not checked/);
    expect(relaxed).toMatch(/Never claim you changed a file unless a tool call actually succeeded/);
  });

  it('turns the wide-change check-in on and off', () => {
    const call = {
      tool: 'edit_file',
      input: { path: 'src/a.ts' },
      changedSoFar: WIDE_CHANGE_THRESHOLD,
    };
    expect(classify(call).decision).toBe('ask');
    expect(classify({ ...call, wideChangeThreshold: null }).decision).toBe('auto');
  });

  /** Whatever the threshold says, these always ask. */
  it('never lets the setting excuse a destructive or external call', () => {
    expect(
      classify({
        tool: 'delete_file',
        input: { path: 'src/a.ts' },
        changedSoFar: 0,
        wideChangeThreshold: null,
      }).decision,
    ).toBe('ask');
    expect(
      classify({
        tool: 'run_command',
        input: { command: 'rm -rf src' },
        changedSoFar: 0,
        wideChangeThreshold: null,
      }).decision,
    ).toBe('ask');
  });
});

describe('settings persistence', () => {
  it('keeps every new group after a reset', () => {
    const settings = useSettingsStore.getState();
    settings.setTerminal({ fontSize: 16 });
    settings.setGit({ defaultBranch: 'trunk' });
    settings.setAgent({ verifyAfterEdits: false });
    settings.setWorkspace({ restoreSession: false });

    expect(useSettingsStore.getState().terminal.fontSize).toBe(16);
    expect(useSettingsStore.getState().git.defaultBranch).toBe('trunk');
    expect(useSettingsStore.getState().agent.verifyAfterEdits).toBe(false);
    expect(useSettingsStore.getState().workspace.restoreSession).toBe(false);

    useSettingsStore.getState().resetAll();
    expect(useSettingsStore.getState().terminal.fontSize).toBe(12);
    expect(useSettingsStore.getState().git.defaultBranch).toBe('main');
    expect(useSettingsStore.getState().agent.verifyAfterEdits).toBe(true);
    expect(useSettingsStore.getState().workspace.restoreSession).toBe(true);
  });
});
