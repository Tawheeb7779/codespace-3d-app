import { beforeEach, describe, expect, it } from 'vitest';
import { toast, useToastStore } from '@/stores/toastStore';

/**
 * What a notification leaves behind.
 *
 * A toast lives four seconds, which is right for the interruption and useless
 * afterwards: the push that failed while the reader was in a file, the save
 * that was refused, the build that finished while they were elsewhere. The
 * toast is the interruption; the history is the record, and it has to outlive
 * both the toast and the button that dismissed it.
 */

beforeEach(() => {
  useToastStore.setState({ toasts: [], history: [], unread: 0 });
});

describe('what is announced', () => {
  it('is kept after its toast is gone', () => {
    const id = toast.error('Push rejected', 'The remote has commits you do not have.');
    useToastStore.getState().dismiss(id);

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().history).toHaveLength(1);
    expect(useToastStore.getState().history[0].title).toBe('Push rejected');
    expect(useToastStore.getState().history[0].description).toMatch(/commits you do not have/);
  });

  it('survives clearing the toasts on screen', () => {
    toast.success('Committed');
    toast.info('Preview stopped');

    useToastStore.getState().clear();

    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().history).toHaveLength(2);
  });

  it('reads newest first, which is the order it will be looked at in', () => {
    toast.info('first');
    toast.info('second');
    toast.info('third');

    expect(useToastStore.getState().history.map((entry) => entry.title)).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('carries when it happened, not only what it said', () => {
    const before = Date.now();
    toast.warning('Rate limited');

    const [entry] = useToastStore.getState().history;
    expect(entry.at).toBeGreaterThanOrEqual(before);
    expect(entry.at).toBeLessThanOrEqual(Date.now());
  });

  it('does not grow without bound over a long session', () => {
    for (let i = 0; i < 140; i++) toast.info(`message ${i}`);

    const { history } = useToastStore.getState();
    expect(history).toHaveLength(100);
    // The cap drops the oldest, not the newest.
    expect(history[0].title).toBe('message 139');
  });
});

describe('the unread count', () => {
  it('counts what has arrived since the centre was last opened', () => {
    toast.info('one');
    toast.info('two');
    expect(useToastStore.getState().unread).toBe(2);

    useToastStore.getState().markRead();
    expect(useToastStore.getState().unread).toBe(0);

    toast.info('three');
    expect(useToastStore.getState().unread).toBe(1);
  });

  it('goes to nothing when the history is cleared', () => {
    toast.error('Something went wrong');

    useToastStore.getState().clearHistory();

    expect(useToastStore.getState().history).toHaveLength(0);
    expect(useToastStore.getState().unread).toBe(0);
  });
});

describe('the toasts themselves are unchanged', () => {
  it('still expires everything but an error on its own', () => {
    toast.success('Saved');
    toast.error('Refused');

    const [saved, refused] = useToastStore.getState().toasts;
    expect(saved.duration).toBeGreaterThan(0);
    // An error waits to be read rather than vanishing mid-sentence.
    expect(refused.duration).toBe(0);
  });

  it('still shows only the last few at once', () => {
    for (let i = 0; i < 9; i++) toast.info(`toast ${i}`);

    expect(useToastStore.getState().toasts.length).toBeLessThanOrEqual(5);
    // But nothing was lost from the record.
    expect(useToastStore.getState().history).toHaveLength(9);
  });
});
