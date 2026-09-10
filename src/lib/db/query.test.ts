import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  EMPTY_RESULT_NOTE,
  MAX_ROWS,
  describeQuery,
  explainDatabaseError,
  parseQuery,
} from '@/lib/db/query';

/**
 * The one property this parser exists to hold: **it never runs something else.**
 *
 * A SQL box in front of PostgREST can only translate a small subset. The
 * dangerous failure is not refusing a query — it is accepting a query, silently
 * dropping the part it did not understand, and showing the result of a
 * *different* question as though it answered the one that was typed. In a
 * database tool that result is what gets acted on.
 *
 * So every construct outside the subset is checked here to be refused **by
 * name**, and the refusal is checked to carry a reason. A write statement in
 * particular must never reach a translation path at all.
 */

describe('the supported shape', () => {
  it('translates a plain select', () => {
    const result = parseQuery('select id, name from projects');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.table).toBe('projects');
    expect(result.query.columns).toEqual(['id', 'name']);
    expect(result.query.limit).toBe(DEFAULT_LIMIT);
  });

  it('keeps a star as a star', () => {
    const result = parseQuery('select * from projects');

    expect(result.ok && result.query.columns).toEqual(['*']);
  });

  it('strips a schema prefix from the table', () => {
    expect(parseQuery('select * from public.projects').ok).toBe(true);
    const result = parseQuery('select * from public.projects');
    expect(result.ok && result.query.table).toBe('projects');
  });

  it('ignores a trailing semicolon and a comment', () => {
    expect(parseQuery('select * from projects; -- browse').ok).toBe(true);
  });

  it.each([
    ['=', 'eq'],
    ['!=', 'neq'],
    ['<>', 'neq'],
    ['>', 'gt'],
    ['>=', 'gte'],
    ['<', 'lt'],
    ['<=', 'lte'],
  ])('translates %s to %s', (sql, operator) => {
    const result = parseQuery(`select * from t where a ${sql} 3`);

    expect(result.ok && result.query.filters[0]).toEqual({ column: 'a', operator, value: '3' });
  });

  it('unquotes a string value', () => {
    const result = parseQuery("select * from t where name = 'ada'");

    expect(result.ok && result.query.filters[0].value).toBe('ada');
  });

  it('translates like', () => {
    const result = parseQuery("select * from t where name like '%ada%'");

    expect(result.ok && result.query.filters[0]).toEqual({
      column: 'name',
      operator: 'like',
      value: '%ada%',
    });
  });

  it.each([
    ['is null', 'null'],
    ['is not null', 'not.null'],
  ])('translates %s', (sql, value) => {
    const result = parseQuery(`select * from t where deleted_at ${sql}`);

    expect(result.ok && result.query.filters[0]).toEqual({
      column: 'deleted_at',
      operator: 'is',
      value,
    });
  });

  it('joins several conditions with and', () => {
    const result = parseQuery("select * from t where a = 1 and b = 'x'");

    expect(result.ok && result.query.filters).toHaveLength(2);
  });

  it('reads the order', () => {
    const result = parseQuery('select * from t order by created_at desc');

    expect(result.ok && result.query.orderBy).toEqual({ column: 'created_at', ascending: false });
  });

  it('defaults an unqualified order to ascending', () => {
    const result = parseQuery('select * from t order by name');

    expect(result.ok && result.query.orderBy?.ascending).toBe(true);
  });
});

describe('the row limit', () => {
  it('honours a limit under the cap', () => {
    const result = parseQuery('select * from t limit 10');

    expect(result.ok && result.query.limit).toBe(10);
  });

  /** A browse must not try to pull a whole table into a panel. */
  it('clamps a limit above the cap', () => {
    const result = parseQuery('select * from t limit 100000');

    expect(result.ok && result.query.limit).toBe(MAX_ROWS);
  });
});

describe('what it refuses, and why', () => {
  it.each([
    ['select a from x join y on x.id = y.x_id', 'JOIN'],
    ['select count(*) from x group by a', 'GROUP BY'],
    ['select * from x union select * from y', 'UNION'],
    ['with recent as (select * from x) select * from recent', 'a common table expression'],
    ['select * from x where id in (select id from y)', 'a subquery'],
  ])('refuses %s by name', (sql, construct) => {
    const result = parseQuery(sql);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupported.construct).toBe(construct);
    expect(result.unsupported.reason.length).toBeGreaterThan(20);
  });

  /**
   * The one that matters most. Each of these must be named as a change, never
   * partially translated into a select that returns plausible rows.
   */
  it.each([
    "insert into projects (name) values ('x')",
    "update projects set name = 'x'",
    'delete from projects',
    'drop table projects',
    'alter table projects add column x int',
    'create table x (id int)',
    'truncate projects',
    'grant select on projects to anon',
    'revoke select on projects from anon',
  ])('refuses to run "%s"', (sql) => {
    const result = parseQuery(sql);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.unsupported.construct).toBe('a statement that changes the database');
  });

  it('refuses OR in a where clause rather than dropping it', () => {
    const result = parseQuery("select * from t where a = 1 or b = 2");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.unsupported.construct).toBe('OR in a where clause');
  });

  it('refuses a comparison it cannot translate', () => {
    const result = parseQuery('select * from t where a between 1 and 2');

    expect(result.ok).toBe(false);
  });

  it('refuses an empty query', () => {
    expect(parseQuery('   ').ok).toBe(false);
    expect(parseQuery('').ok).toBe(false);
  });

  it('refuses prose, and says what the shape is', () => {
    const result = parseQuery('show me the projects');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.unsupported.reason).toMatch(/select <columns> from <table>/);
  });
});

describe('describing a query before it runs', () => {
  it('names the table, the columns, the filters and the limit', () => {
    const result = parseQuery("select id from t where a = 1 order by a desc limit 5");
    const text = describeQuery(result.ok ? result.query : { table: '', columns: [], filters: [], limit: 0 });

    expect(text).toContain('from t');
    expect(text).toContain('select id');
    expect(text).toContain('a eq 1');
    expect(text).toContain('order a desc');
    expect(text).toContain('limit 5');
  });
});

describe('explaining what the database said', () => {
  /**
   * The distinction a person can lose an afternoon to: refused-by-policy and
   * genuinely-absent look identical on screen.
   */
  it('says row-level security refused it', () => {
    const text = explainDatabaseError('permission denied for table projects', '42501');

    expect(text).toMatch(/row-level security/i);
    expect(text).toContain('permission denied for table projects');
  });

  it('says a table is not exposed', () => {
    expect(explainDatabaseError('relation "x" does not exist', '42P01')).toMatch(
      /not exposed to the API/i,
    );
  });

  it('says a column is not on the table', () => {
    expect(explainDatabaseError('column "x" does not exist', '42703')).toMatch(/not on this table/i);
  });

  it('recognises the message even with no code', () => {
    expect(explainDatabaseError('permission denied for table projects')).toMatch(
      /row-level security/i,
    );
  });

  it('passes an unrecognised message through unchanged', () => {
    expect(explainDatabaseError('something else went wrong')).toBe('something else went wrong');
  });

  /** Empty is ambiguous under RLS, and the note has to say both readings. */
  it('says empty may mean policy rather than absence', () => {
    expect(EMPTY_RESULT_NOTE).toMatch(/row-level security/i);
    expect(EMPTY_RESULT_NOTE).toMatch(/table is empty/i);
  });
});
