import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A read that returned nothing must not be reported as an empty project.
 *
 * `saveFiles.test.ts` covers the other half of this. A write whose rows row
 * level security quietly refused came back 200 with nothing stored, and the
 * fix was to ask for the paths back and check they arrived — `assertWrote`.
 *
 * The read had no such guard, and it fails the same way for the same reason:
 * PostgREST does not error when a policy simply makes rows invisible. It
 * filters them and answers 200 with `[]`. So `getProject` built
 * `files: {}` and handed back a project that looked like it had been created
 * empty, and the workspace opened on nothing — the same symptom from the other
 * direction:
 *
 *   open a project you have been working in, and every file is gone, with
 *   nothing on screen having said anything went wrong.
 *
 * Every project this application creates is created *with* files: a template
 * always ships at least one, and `createProject` writes them under
 * `assertWrote`. So a project row that reads back with zero file rows is not a
 * project with no files. It is a read that did not return them, and the honest
 * thing is to say so rather than to present the absence as content.
 */

vi.mock('@/lib/supabase', () => ({
  requireSupabase: () => client,
  supabaseHost: () => 'example-project.supabase.co',
  isSupabaseConfigured: () => true,
}));

const { supabaseRepository } = await import('@/lib/repo/supabaseRepository');

type Result = { data: unknown; error: unknown };

let plan: Record<string, Result[]>;

const nextFor = (table: string): Result => plan[table]?.shift() ?? { data: [], error: null };

/** The same stand-in `saveFiles.test.ts` uses: every builder method is the chain. */
function makeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => () => builder;
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
        builder[name] = chain();
      }
      builder.maybeSingle = () => Promise.resolve(nextFor(table));
      builder.single = () => Promise.resolve(nextFor(table));
      builder.then = (resolve: (value: Result) => unknown) =>
        Promise.resolve(nextFor(table)).then(resolve);
      return builder;
    },
  };
}

let client: ReturnType<typeof makeClient>;

const PROJECT = '44444444-4444-4444-4444-444444444444';

/** The columns `rowToMeta` reads, so a planned row is a realistic one. */
const projectRow = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  owner_id: '11111111-1111-1111-1111-111111111111',
  name: 'Persisted',
  description: '',
  template: 'vanilla',
  language: 'javascript',
  visibility: 'private',
  dirs: ['src'],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  client = makeClient();
  plan = {};
});

describe('loading a project whose files the database did not return', () => {
  /** The failure this file exists for. */
  it('refuses to present zero file rows as an empty project', async () => {
    plan.projects = [{ data: projectRow(), error: null }];
    plan.project_files = [{ data: [], error: null }];

    await expect(supabaseRepository.getProject(PROJECT)).rejects.toThrow(/no files/i);
  });

  it('names the project so the message is actionable', async () => {
    plan.projects = [{ data: projectRow(), error: null }];
    plan.project_files = [{ data: [], error: null }];

    await expect(supabaseRepository.getProject(PROJECT)).rejects.toThrow(/Persisted/);
  });

  /**
   * Row level security is the likely cause, so the message has to point at it
   * without asserting it: the rows could also have been deleted.
   */
  it('says what to check rather than guessing at one cause', async () => {
    plan.projects = [{ data: projectRow(), error: null }];
    plan.project_files = [{ data: [], error: null }];

    await expect(supabaseRepository.getProject(PROJECT)).rejects.toThrow(
      /project_files|permission|row level/i,
    );
  });
});

describe('what must keep working', () => {
  it('returns the files when the database returns them', async () => {
    plan.projects = [{ data: projectRow(), error: null }];
    plan.project_files = [
      {
        data: [
          { path: 'index.html', content: '<h1>hi</h1>' },
          { path: 'src/main.js', content: 'console.log(1)' },
        ],
        error: null,
      },
    ];

    const project = await supabaseRepository.getProject(PROJECT);

    expect(project?.files).toEqual({
      'index.html': '<h1>hi</h1>',
      'src/main.js': 'console.log(1)',
    });
    expect(project?.dirs).toEqual(['src']);
  });

  /** A project that is genuinely not there is still null, not an error. */
  it('still reports a missing project as null', async () => {
    plan.projects = [{ data: null, error: null }];

    await expect(supabaseRepository.getProject(PROJECT)).resolves.toBeNull();
  });

  /** A real error still surfaces as itself, with its code. */
  it('still surfaces a database error on the project read', async () => {
    plan.projects = [
      { data: null, error: { code: 'PGRST301', message: 'JWT expired' } },
    ];

    await expect(supabaseRepository.getProject(PROJECT)).rejects.toThrow(/Could not load project/);
  });

  it('still surfaces a database error on the file read', async () => {
    plan.projects = [{ data: projectRow(), error: null }];
    plan.project_files = [
      { data: null, error: { code: '42501', message: 'permission denied' } },
    ];

    await expect(supabaseRepository.getProject(PROJECT)).rejects.toThrow(
      /Could not load project files/,
    );
  });
});
