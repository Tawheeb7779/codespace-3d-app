import { describe, expect, it } from 'vitest';
import {
  mentionQuery,
  resolveMentions,
  toThreads,
  type Comment,
} from '@/lib/collab/comments';

/**
 * The parts of a comment that are decided in the browser.
 *
 * Authorship, visibility and who may resolve a thread are the database's, and
 * are proven against real PostgreSQL in `supabase/tests/rls.sql`. What is left
 * here is threading and mentions, and both have a way of quietly losing
 * something: a reply whose parent is gone can disappear, and an `@name` that
 * matches nobody can look like it notified somebody.
 */

const comment = (over: Partial<Comment> & { id: string }): Comment => ({
  projectId: 'p1',
  parentId: null,
  authorId: 'u1',
  authorName: 'Amina',
  path: 'src/app.ts',
  line: null,
  body: 'a comment',
  mentions: [],
  resolvedAt: null,
  createdAt: 1,
  ...over,
});

describe('grouping comments into threads', () => {
  it('puts replies under the comment they answer', () => {
    const threads = toThreads([
      comment({ id: 'root', createdAt: 1 }),
      comment({ id: 'r1', parentId: 'root', createdAt: 2 }),
      comment({ id: 'r2', parentId: 'root', createdAt: 3 }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((reply) => reply.id)).toEqual(['r1', 'r2']);
  });

  it('orders replies as they were written', () => {
    const threads = toThreads([
      comment({ id: 'root', createdAt: 1 }),
      comment({ id: 'later', parentId: 'root', createdAt: 9 }),
      comment({ id: 'earlier', parentId: 'root', createdAt: 2 }),
    ]);

    expect(threads[0].replies.map((reply) => reply.id)).toEqual(['earlier', 'later']);
  });

  it('orders threads by when each was opened', () => {
    const threads = toThreads([
      comment({ id: 'second', createdAt: 20 }),
      comment({ id: 'first', createdAt: 10 }),
    ]);

    expect(threads.map((thread) => thread.root.id)).toEqual(['first', 'second']);
  });

  /**
   * Losing somebody's words because the comment above them was deleted is
   * worse than showing them slightly out of place.
   */
  it('keeps a reply whose parent is gone rather than dropping it', () => {
    const threads = toThreads([comment({ id: 'orphan', parentId: 'deleted', createdAt: 5 })]);

    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe('orphan');
  });

  it('is empty for no comments', () => {
    expect(toThreads([])).toEqual([]);
  });
});

describe('resolving mentions', () => {
  const members = [
    { userId: 'u-amina', displayName: 'Amina' },
    { userId: 'u-bilal', displayName: 'Bilal' },
    { userId: 'u-amina-bello', displayName: 'Amina Bello' },
  ];

  it('finds a named member', () => {
    expect(resolveMentions('can @Bilal look at this?', members)).toEqual(['u-bilal']);
  });

  /**
   * Otherwise naming one person also notifies whoever's name is a prefix of
   * theirs — somebody pulled into a thread they were never named in.
   */
  it('names only the longest match, not everyone whose name is inside it', () => {
    const found = resolveMentions('@Amina Bello please review', members);

    expect(found).toEqual(['u-amina-bello']);
  });

  it('still names both when both are genuinely named', () => {
    const found = resolveMentions('@Amina Bello and @Amina', members);

    expect(new Set(found)).toEqual(new Set(['u-amina-bello', 'u-amina']));
  });

  it('matches regardless of case', () => {
    expect(resolveMentions('@bilal', members)).toEqual(['u-bilal']);
  });

  /**
   * A mention that resolves to a stranger would notify somebody who cannot
   * read the code being discussed.
   */
  it('ignores a name that belongs to nobody on the project', () => {
    expect(resolveMentions('@Nobody take a look', members)).toEqual([]);
  });

  it('names each person once however often they appear', () => {
    expect(resolveMentions('@Bilal and @Bilal again', members)).toEqual(['u-bilal']);
  });

  it('is bounded, so one comment cannot notify everybody forever', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      userId: `u${index}`,
      displayName: `Person${index}`,
    }));
    const body = many.map((person) => `@${person.displayName}`).join(' ');

    expect(resolveMentions(body, many).length).toBeLessThanOrEqual(50);
  });
});

describe('the mention being typed', () => {
  it('reports the fragment after an @', () => {
    expect(mentionQuery('hey @bil', 8)).toBe('bil');
  });

  it('reports an empty fragment the moment @ is typed', () => {
    expect(mentionQuery('hey @', 5)).toBe('');
  });

  it('is nothing when no @ has been typed', () => {
    expect(mentionQuery('hey there', 9)).toBeNull();
  });

  /** An email address is not somebody being named. */
  it('ignores an @ that does not start a word', () => {
    expect(mentionQuery('mail me at amina@example.test', 28)).toBeNull();
  });

  it('ends at a newline', () => {
    expect(mentionQuery('@bilal\nand then', 15)).toBeNull();
  });

  it('gives up on a fragment too long to be a name', () => {
    expect(mentionQuery(`@${'x'.repeat(60)}`, 61)).toBeNull();
  });

  it('reads the fragment at the caret, not the last one in the text', () => {
    const body = '@amina said to ask @bil';

    expect(mentionQuery(body, 6)).toBe('amina');
    expect(mentionQuery(body, body.length)).toBe('bil');
  });
});
