import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT } from '@/lib/ai/contextControl';
import { mergePersisted } from '@/stores/aiStore';

/**
 * Context choices saved before a source existed.
 *
 * The store persists the whole `context` object, and zustand's default merge
 * replaces it with what was stored. So a source added after someone's last
 * visit arrives as `undefined` — falsy, therefore off, permanently, for exactly
 * the existing users the new default was written for. A feature nobody who
 * already uses the product ever receives is not shipped.
 *
 * These drive the store's own merge — imported, not reimplemented, so a change
 * to the real function fails here rather than passing against a copy of the old
 * one. Re-hydrating the whole store from a fake localStorage would test zustand
 * more than it tests this, and the merge is where the decision lives.
 */

type Current = Parameters<typeof mergePersisted>[1];

const merge = (persisted: unknown, current: Current) => mergePersisted(persisted, current);

let current: Current;

beforeEach(() => {
  current = { context: { ...DEFAULT_CONTEXT } } as Current;
});

describe('rehydrating older choices', () => {
  it('gives a new source its default rather than leaving it undefined', () => {
    // Saved before projectInstructions existed.
    const old = {
      context: {
        currentFile: true,
        selection: true,
        openFiles: false,
        projectOutline: true,
        diagnostics: true,
        gitDiff: false,
        terminal: false,
      },
    };

    const merged = merge(old, current);

    expect(merged.context.projectInstructions).toBe(DEFAULT_CONTEXT.projectInstructions);
    expect(merged.context.projectInstructions).not.toBeUndefined();
  });

  it('keeps every choice the user actually made', () => {
    const old = {
      context: {
        ...DEFAULT_CONTEXT,
        // Deliberately the opposite of the defaults, so a lost answer shows.
        currentFile: false,
        terminal: true,
        gitDiff: true,
      },
    };

    const merged = merge(old, current);

    expect(merged.context.currentFile).toBe(false);
    expect(merged.context.terminal).toBe(true);
    expect(merged.context.gitDiff).toBe(true);
  });

  it('respects a new source the user has already turned off', () => {
    const old = { context: { ...DEFAULT_CONTEXT, projectInstructions: false } };

    expect(merge(old, current).context.projectInstructions).toBe(false);
  });

  it('falls back to the defaults for a first run with nothing stored', () => {
    expect(merge(undefined, current).context).toEqual(DEFAULT_CONTEXT);
  });

  it('survives a stored blob with no context at all', () => {
    expect(merge({ provider: { kind: 'none' } }, current).context).toEqual(DEFAULT_CONTEXT);
  });

  it('carries the rest of the persisted state through untouched', () => {
    const old = { provider: { kind: 'openai', model: 'some-model' }, context: {} };

    const merged = merge(old, current) as unknown as { provider: { model: string } };

    expect(merged.provider.model).toBe('some-model');
  });
});
