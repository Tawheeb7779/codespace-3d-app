import { describe, expect, it } from 'vitest';
import {
  parseColumn,
  parseSchema,
  relationshipsIn,
  splitTopLevel,
  tableForeignKeys,
  tablePrimaryKey,
} from '@/lib/db/schema';

/**
 * Reading a schema out of migrations, and the two ways that goes wrong.
 *
 * A naive comma split breaks `numeric(10, 2)` and every `check (… in (…, …))`,
 * which is most of the interesting columns in a real schema — and the failure is
 * silent: the panel shows a column called `2)` and nobody notices the real one
 * is missing.
 *
 * And a statement the parser did not understand must be *counted*, not dropped.
 * A schema browser that quietly omits a table is worse than one that says it
 * could not read three statements, because the first looks complete.
 */

describe('splitting a table body', () => {
  it('does not split inside a type’s brackets', () => {
    expect(splitTopLevel('amount numeric(10, 2), name text')).toEqual([
      'amount numeric(10, 2)',
      'name text',
    ]);
  });

  it('does not split inside a check constraint', () => {
    expect(splitTopLevel("state text, check (state in ('a', 'b'))")).toEqual([
      'state text',
      "check (state in ('a', 'b'))",
    ]);
  });

  it('keeps a trailing part with no comma after it', () => {
    expect(splitTopLevel('a int, b int')).toHaveLength(2);
  });
});

describe('one column definition', () => {
  it('reads the name and the type', () => {
    expect(parseColumn('title text')).toMatchObject({ name: 'title', type: 'text' });
  });

  it('keeps a parameterised type whole', () => {
    expect(parseColumn('amount numeric(10, 2) not null')?.type).toBe('numeric(10, 2)');
  });

  it('reads an array type', () => {
    expect(parseColumn('tags text[]')?.type).toBe('text[]');
  });

  it('marks not null', () => {
    expect(parseColumn('title text not null')?.nullable).toBe(false);
    expect(parseColumn('title text')?.nullable).toBe(true);
  });

  /** A primary key is not nullable whatever else the line says. */
  it('treats a primary key as not nullable', () => {
    const column = parseColumn('id uuid primary key');

    expect(column?.primaryKey).toBe(true);
    expect(column?.nullable).toBe(false);
  });

  it('reads a column-level foreign key', () => {
    expect(parseColumn('owner_id uuid references public.profiles(id)')?.references).toEqual({
      table: 'profiles',
      column: 'id',
    });
  });

  it('reads a default', () => {
    expect(parseColumn('created_at timestamptz default now()')?.default).toBe('now()');
  });

  /** A constraint line is not a column, and inventing one would be a fake row. */
  it.each([
    'primary key (a, b)',
    'foreign key (a) references t(id)',
    'constraint uq unique (a)',
    "check (state in ('a'))",
    'unique (a, b)',
  ])('refuses to read "%s" as a column', (line) => {
    expect(parseColumn(line)).toBeNull();
  });
});

describe('table-level constraints', () => {
  it('finds a composite primary key', () => {
    expect(tablePrimaryKey(['a uuid', 'b uuid', 'primary key (a, b)'])).toEqual(['a', 'b']);
  });

  it('finds one written with a constraint name', () => {
    expect(tablePrimaryKey(['a uuid', 'constraint pk_x primary key ("a")'])).toEqual(['a']);
  });

  it('reports none when there is none', () => {
    expect(tablePrimaryKey(['a uuid'])).toEqual([]);
  });

  it('finds a table-level foreign key', () => {
    expect(tableForeignKeys(['foreign key (owner_id) references profiles (id)'])).toEqual([
      { column: 'owner_id', table: 'profiles', target: 'id' },
    ]);
  });
});

const MIGRATION = `
-- a comment mentioning create table nothing
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  amount numeric(10, 2),
  visibility text not null default 'private',
  check (visibility in ('private', 'public'))
);

create index idx_projects_owner on public.projects (owner_id);
create unique index if not exists uq_projects_name on projects (owner_id, name);
`;

describe('a whole migration', () => {
  const report = parseSchema({ 'supabase/migrations/0001_projects.sql': MIGRATION });

  it('finds the table', () => {
    expect(report.tables.map((table) => table.name)).toEqual(['projects']);
  });

  it('records which migration declared it', () => {
    expect(report.tables[0].source).toBe('supabase/migrations/0001_projects.sql');
  });

  /** The bracket walk: a `check (…)` must not end the body early. */
  it('reads every column past a nested bracket', () => {
    expect(report.tables[0].columns.map((column) => column.name)).toEqual([
      'id',
      'owner_id',
      'name',
      'amount',
      'visibility',
    ]);
  });

  it('reads the indexes, and which are unique', () => {
    expect(report.indexes).toEqual([
      { name: 'idx_projects_owner', table: 'projects', columns: ['owner_id'], unique: false },
      {
        name: 'uq_projects_name',
        table: 'projects',
        columns: ['owner_id', 'name'],
        unique: true,
      },
    ]);
  });

  it('lists the files it read', () => {
    expect(report.sources).toEqual(['supabase/migrations/0001_projects.sql']);
  });

  it('derives the relationships', () => {
    expect(relationshipsIn(report)).toEqual([
      { from: 'projects', column: 'owner_id', to: 'profiles', target: 'id' },
    ]);
  });

  it('ignores files that are not SQL', () => {
    const other = parseSchema({ 'src/app.ts': 'create table x (id int);' });

    expect(other.tables).toEqual([]);
    expect(other.sources).toEqual([]);
  });

  /**
   * The honesty guard: a body it could not read is counted, so the panel can
   * say the picture is incomplete instead of looking complete.
   */
  it('counts a table body it could not read', () => {
    const odd = parseSchema({ 'a.sql': 'create table weird (primary key (a));' });

    expect(odd.tables).toEqual([]);
    expect(odd.skipped).toBe(1);
  });

  it('reports nothing skipped when it read everything', () => {
    expect(report.skipped).toBe(0);
  });
});

describe('a table declared across two migrations', () => {
  it('keeps the later declaration, sorted by file name', () => {
    const report = parseSchema({
      'supabase/migrations/0002_projects.sql': 'create table projects (id uuid, extra text);',
      'supabase/migrations/0001_projects.sql': 'create table projects (id uuid);',
    });

    expect(report.tables).toHaveLength(1);
    expect(report.tables[0].columns.map((column) => column.name)).toEqual(['id', 'extra']);
  });
});
