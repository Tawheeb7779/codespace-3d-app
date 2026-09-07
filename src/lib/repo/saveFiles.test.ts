import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A save that wrote nothing must not be reported as a save.
 *
 * This is the pattern the rest of the repository already guards with
 * `assertChanged`: PostgREST reports no error when row level security simply
 * makes the target rows invisible or refuses them on the update path. The
 * statement matches nothing, the response is 200, and the caller has no way to
 * tell that apart from success.
 *
 * The file rows were the one write that had no such guard, and they are the
 * ones carrying the user's work. The failure a user sees is exactly that:
 *
 *   create a file, type in it, wait for the auto-save, refresh — and the file
 *   is gone, with nothing on screen having said anything went wrong.
 *
 * So the upsert now asks for the paths back and checks that every path it sent
 * came back. `project_files_select` is `can_read_project(project_id)`, which is
 * answerable from a project row that already exists, so asking for a
 * representation here does not repeat the trap that broke project creation —
 * where the SELECT policy could not see the row the same statement was
 * inserting.
 */

vi.mock('@/lib/supabase', () => ({
  requireSupabase: () => client,
  supabaseHost: () => 'example-project.supabase.co',
  isSupabaseConfigured: () => true,
}));

const { supabaseRepository } = await import('@/lib/repo/supabaseRepository');

type Result = { data: unknown; error: unknown };

/** What each table's operations should answer with, in call order. */
let plan: Record<string, Result[]>;
let sent: Array<{ table: string; op: string; rows?: unknown }>;

const nextFor = (table: string): Result =>
  plan[table]?.shift() ?? { data: [], error: null };

/**
 * A stand-in for the Supabase client that records what was sent and answers
 * from `plan`. Every builder method returns the same thenable, so a chain of
 * any shape resolves to the planned result.
 */
function makeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      let op = 'select';
      const chain = (name: string) =>
        (...args: unknown[]) => {
          if (['select', 'insert', 'upsert', 'update', 'delete'].includes(name)) {
            op = name;
            sent.push({ table, op: name, rows: args[0] });
          }
          return builder;
        };
      for (const name of [
        'select',
        'insert',
        'upsert',
        'update',
        'delete',
        'eq',
        'in',
        'order',
        'limit',
      ]) {
        builder[name] = chain(name);
      }
      builder.maybeSingle = () => Promise.resolve(nextFor(table));
      builder.single = () => Promise.resolve(nextFor(table));
      builder.then = (resolve: (value: Result) => unknown) => {
        void op;
        return Promise.resolve(nextFor(table)).then(resolve);
      };
      return builder;
    },
  };
}

let client: ReturnType<typeof makeClient>;

const PROJECT = '33333333-3333-3333-3333-333333333333';
const files = { 'index.html': '<h1>hi</h1>', 'src/main.js': 'console.log(1)' };

beforeEach(() => {
  client = makeClient();
  sent = [];
  plan = {};
});

/**
 * The statements `saveFiles` issues, in order: read the known paths, delete
 * anything the tree no longer has, upsert what changed, update the project row.
 * The delete only runs when something was actually removed, so it only takes a
 * slot in the plan when `known` holds a path the tree does not.
 */
const planSave = (options: { known?: string[]; written?: string[]; project?: boolean }) => {
  const known = options.known ?? [];
  const removes = known.some((path) => !(path in files));
  plan.project_files = [
    { data: known.map((path) => ({ path })), error: null },
    ...(removes ? [{ data: [], error: null }] : []),
    { data: (options.written ?? []).map((path) => ({ path })), error: null },
  ];
  plan.projects = [{ data: options.project === false ? [] : [{ id: PROJECT }], error: null }];
};

describe('when the database really wrote the files', () => {
  it('completes, and sends every changed path', async () => {
    planSave({ known: ['index.html'], written: ['index.html', 'src/main.js'] });

    await expect(
      supabaseRepository.saveFiles(PROJECT, files, [], new Set(Object.keys(files))),
    ).resolves.toBeUndefined();

    const upsert = sent.find((s) => s.op === 'upsert');
    expect((upsert?.rows as Array<{ path: string }>).map((r) => r.path).sort()).toEqual([
      'index.html',
      'src/main.js',
    ]);
  });
});

describe('when row level security silently writes nothing', () => {
  /** The reported failure: no error, no rows, and the work is gone on reload. */
  it('refuses to report a save that produced no rows', async () => {
    planSave({ known: ['index.html'], written: [] });

    await expect(
      supabaseRepository.saveFiles(PROJECT, files, [], new Set(Object.keys(files))),
    ).rejects.toThrow(/not saved|permission/i);
  });

  it('names the files that did not land when only some did', async () => {
    planSave({ known: [], written: ['index.html'] });

    await expect(
      supabaseRepository.saveFiles(PROJECT, files, [], new Set(Object.keys(files))),
    ).rejects.toThrow(/src\/main\.js/);
  });

  it('still reports the project row separately when that is what was refused', async () => {
    planSave({ known: [], written: ['index.html', 'src/main.js'], project: false });

    await expect(
      supabaseRepository.saveFiles(PROJECT, files, [], new Set(Object.keys(files))),
    ).rejects.toThrow(/folder list/i);
  });
});

describe('when there was nothing to write', () => {
  it('does not invent a failure', async () => {
    plan.project_files = [
      { data: [{ path: 'index.html' }, { path: 'src/main.js' }], error: null },
      { data: [], error: null },
    ];
    plan.projects = [{ data: [{ id: PROJECT }], error: null }];

    // Nothing changed, and every path is already known to the server.
    await expect(
      supabaseRepository.saveFiles(PROJECT, files, [], new Set()),
    ).resolves.toBeUndefined();
    expect(sent.some((s) => s.op === 'upsert')).toBe(false);
  });
});
