import { describe, expect, it } from 'vitest';
import { activityEvent, describeActivity, MAX_SUBJECT, mergeActivity, redact } from '@/lib/activity';
import type { ActivityEvent } from '@/types';

/**
 * The activity timeline is shared, persisted, and written from code paths that
 * handle credentials — a push knows a token, an agent turn knows a key. None of
 * that may reach a row every project member can read, so redaction is tested
 * against the shapes that would actually leak rather than a token-looking
 * placeholder.
 */

describe('redact', () => {
  it('keeps ordinary subjects intact', () => {
    expect(redact('a1b2c3d feat: add the parser')).toBe('a1b2c3d feat: add the parser');
    expect(redact('octocat/demo main')).toBe('octocat/demo main');
  });

  it('removes GitHub tokens in both formats', () => {
    expect(redact(`pushed with ghp_${'a'.repeat(36)}`)).not.toContain('ghp_');
    expect(redact(`pushed with github_pat_${'b'.repeat(40)}`)).not.toContain('github_pat_');
    expect(redact(`gho_${'c'.repeat(36)}`)).toBe('[redacted]');
  });

  it('removes provider API keys', () => {
    const key = `sk-ant-api03-${'x'.repeat(40)}`;
    expect(redact(`failed with ${key}`)).not.toContain(key);
    expect(redact(`sk-${'y'.repeat(32)}`)).toBe('[redacted]');
  });

  it('removes anything JWT-shaped, which is what a Supabase key looks like', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJl';
    expect(redact(`token ${jwt}`)).not.toContain('eyJ');
  });

  it('removes assignments whose name suggests a secret', () => {
    for (const text of [
      'API_KEY=hunter2',
      'DATABASE_PASSWORD: correct-horse',
      'authToken = abc123',
      'SUPABASE_SERVICE_ROLE_KEY=whatever',
    ]) {
      expect(redact(text), text).toContain('[redacted]');
      expect(redact(text), text).not.toMatch(/hunter2|correct-horse|abc123|whatever/);
    }
  });

  it('removes credentials embedded in a URL', () => {
    expect(redact('cloning https://user:pa55word@github.com/o/r')).not.toContain('pa55word');
  });

  it('collapses whitespace, so one row stays one line', () => {
    expect(redact('fix   the\n\nparser\t bug')).toBe('fix the parser bug');
  });

  it('bounds the length', () => {
    const long = redact('x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(MAX_SUBJECT);
    expect(long.endsWith('…')).toBe(true);
  });

  it('never writes a non-string into the record', () => {
    expect(redact(undefined)).toBe('');
    expect(redact(null)).toBe('');
    expect(redact({ toString: () => 'sk-secret' })).toBe('');
    expect(redact(42)).toBe('');
  });
});

describe('activityEvent', () => {
  const base = {
    projectId: 'prj_1',
    actorId: 'user_1',
    actorName: 'Ada',
    action: 'commit.created' as const,
  };

  it('redacts the subject on the way in, not on the way out', () => {
    const event = activityEvent({ ...base, subject: `pushed ghp_${'a'.repeat(36)}` }, 'act_1', 1000);
    expect(event.subject).not.toContain('ghp_');
    expect(event.createdAt).toBe(1000);
    expect(event.id).toBe('act_1');
  });

  it('redacts the actor name too, since it is also free text', () => {
    const event = activityEvent({ ...base, actorName: `sk-${'z'.repeat(32)}` }, 'act_2');
    expect(event.actorName).toBe('[redacted]');
  });

  it('falls back to a name rather than storing an empty one', () => {
    expect(activityEvent({ ...base, actorName: '' }, 'act_3').actorName).toBe('Someone');
  });

  it('handles a missing subject', () => {
    expect(activityEvent(base, 'act_4').subject).toBe('');
  });
});

describe('describeActivity', () => {
  const event = (action: ActivityEvent['action'], subject = ''): ActivityEvent => ({
    id: 'a',
    projectId: 'p',
    actorId: 'u',
    actorName: 'Ada',
    action,
    subject,
    createdAt: 0,
  });

  it('reads as a sentence with and without a subject', () => {
    expect(describeActivity(event('commit.created', 'abc1234 fix'))).toBe('committed — abc1234 fix');
    expect(describeActivity(event('branch.switched'))).toBe('switched branch');
  });
});

describe('mergeActivity', () => {
  const at = (id: string, createdAt: number): ActivityEvent => ({
    id,
    projectId: 'p',
    actorId: 'u',
    actorName: 'Ada',
    action: 'commit.created',
    subject: '',
    createdAt,
  });

  it('puts the newest first and drops duplicates by id', () => {
    const merged = mergeActivity([at('a', 1), at('b', 2)], [at('b', 2), at('c', 3)], 10);
    expect(merged.map((event) => event.id)).toEqual(['c', 'b', 'a']);
  });

  it('caps the list, keeping the newest', () => {
    const existing = Array.from({ length: 50 }, (_, i) => at(`e${i}`, i));
    const merged = mergeActivity(existing, [at('new', 999)], 10);
    expect(merged).toHaveLength(10);
    expect(merged[0].id).toBe('new');
  });
});
