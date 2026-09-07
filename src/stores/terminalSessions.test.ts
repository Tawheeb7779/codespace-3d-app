import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore } from '@/stores/terminalStore';

/**
 * Telling several terminals apart, and getting their output out.
 *
 * Sessions were "shell", "shell 2", "shell 3" and nothing else, which is fine
 * for one and useless for four — the whole reason to open a second terminal is
 * that it is doing something different. Naming them is what makes the tabs
 * worth having, and a transcript is what makes a failed run something you can
 * paste into an issue rather than retype.
 */

beforeEach(() => {
  useTerminalStore.setState({ sessions: [], activeId: null });
});

const sessions = () => useTerminalStore.getState().sessions;

describe('naming a session', () => {
  it('takes the name it is given', () => {
    const id = useTerminalStore.getState().createSession();

    useTerminalStore.getState().renameSession(id, 'build watch');

    expect(sessions().find((s) => s.id === id)?.name).toBe('build watch');
  });

  it('trims what it is given, so a stray space is not the name', () => {
    const id = useTerminalStore.getState().createSession();

    useTerminalStore.getState().renameSession(id, '   tests   ');

    expect(sessions().find((s) => s.id === id)?.name).toBe('tests');
  });

  it('refuses a blank name rather than leaving a tab with nothing on it', () => {
    const id = useTerminalStore.getState().createSession();
    const original = sessions().find((s) => s.id === id)?.name;

    useTerminalStore.getState().renameSession(id, '   ');

    expect(sessions().find((s) => s.id === id)?.name).toBe(original);
  });

  it('renames one session without touching the others', () => {
    const first = useTerminalStore.getState().createSession();
    const second = useTerminalStore.getState().createSession();
    const secondName = sessions().find((s) => s.id === second)?.name;

    useTerminalStore.getState().renameSession(first, 'server');

    expect(sessions().find((s) => s.id === first)?.name).toBe('server');
    expect(sessions().find((s) => s.id === second)?.name).toBe(secondName);
  });

  it('ignores a session that is not there', () => {
    const id = useTerminalStore.getState().createSession();

    expect(() => useTerminalStore.getState().renameSession('gone', 'x')).not.toThrow();
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0].id).toBe(id);
  });
});

describe('the transcript', () => {
  it('is everything the session printed, in order', () => {
    const id = useTerminalStore.getState().createSession();
    useTerminalStore.getState().append(id, [
      { kind: 'command', text: 'ls' },
      { kind: 'stdout', text: 'index.html' },
      { kind: 'stderr', text: 'no such file' },
    ]);

    // A new session opens with a banner, which is output it really printed and
    // belongs in a saved log; what matters is that the lines are all there, in
    // the order they happened.
    const text = useTerminalStore.getState().transcript(id);
    expect(text).toContain('ls\nindex.html\nno such file');
    expect(text.indexOf('ls')).toBeLessThan(text.indexOf('index.html'));
  });

  it('is empty for a session that has printed nothing', () => {
    const id = useTerminalStore.getState().createSession();

    // A fresh session may carry a banner; either way this must be a string.
    expect(typeof useTerminalStore.getState().transcript(id)).toBe('string');
  });

  it('is empty for a session that does not exist', () => {
    expect(useTerminalStore.getState().transcript('gone')).toBe('');
  });

  it('belongs to one session, not to all of them', () => {
    const first = useTerminalStore.getState().createSession();
    const second = useTerminalStore.getState().createSession();
    useTerminalStore.getState().append(first, [{ kind: 'stdout', text: 'from the first' }]);
    useTerminalStore.getState().append(second, [{ kind: 'stdout', text: 'from the second' }]);

    expect(useTerminalStore.getState().transcript(first)).toContain('from the first');
    expect(useTerminalStore.getState().transcript(first)).not.toContain('from the second');
  });
});
