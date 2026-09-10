import { beforeEach, describe, expect, it } from 'vitest';
import {
  envFilesIn,
  findIssues,
  findUsages,
  isPublicPrefixed,
  needsConfirmation,
  parseEnvKeys,
  vaultStatus,
  type EnvVariable,
} from '@/lib/env/manager';
import { useEnvStore } from '@/stores/envStore';

/**
 * Managing environments without pretending to hold their secrets.
 *
 * A browser has nowhere to put a production credential that a browser cannot
 * also read. So the promise this makes is narrow and keepable: it manages
 * names, which environment needs each, whether one is a secret, and where the
 * code reads it — and it refuses to store a secret value at all, in the store
 * rather than in the UI, because a hidden field is not a refusal.
 *
 * The contradiction worth catching is a variable marked secret whose prefix
 * publishes it to every visitor. That label is not merely useless; somebody
 * trusts it.
 */

const variable = (over: Partial<EnvVariable> & { key: string }): EnvVariable => ({
  environments: ['development'],
  secret: false,
  value: '',
  note: '',
  ...over,
});

describe('what the code actually reads', () => {
  it('finds process.env references', () => {
    const usages = findUsages({ 'src/a.ts': 'const url = process.env.DATABASE_URL;' });

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ key: 'DATABASE_URL', path: 'src/a.ts', line: 1 });
  });

  it('finds the bracket spelling too', () => {
    const usages = findUsages({ 'src/a.ts': "const x = process.env['API_HOST'];" });

    expect(usages[0].key).toBe('API_HOST');
  });

  /** A project can use either spelling; covering one under-reports the other. */
  it('finds import.meta.env references', () => {
    const usages = findUsages({ 'src/a.ts': 'const url = import.meta.env.VITE_API_URL;' });

    expect(usages[0].key).toBe('VITE_API_URL');
  });

  it('marks an import.meta reference as reaching the client', () => {
    const usages = findUsages({ 'src/a.ts': 'import.meta.env.ANYTHING' });

    expect(usages[0].clientSide).toBe(true);
  });

  it('marks a public prefix as reaching the client however it is read', () => {
    const usages = findUsages({ 'src/a.ts': 'process.env.NEXT_PUBLIC_URL' });

    expect(usages[0].clientSide).toBe(true);
  });

  it('does not mark an ordinary server variable as client-side', () => {
    const usages = findUsages({ 'src/a.ts': 'process.env.DATABASE_URL' });

    expect(usages[0].clientSide).toBe(false);
  });

  it('reports the line, so a usage can be opened', () => {
    const usages = findUsages({ 'src/a.ts': '\n\nprocess.env.X' });

    expect(usages[0].line).toBe(3);
  });

  it('ignores dependencies and build output', () => {
    expect(findUsages({ 'node_modules/x/i.js': 'process.env.SECRET' })).toEqual([]);
    expect(findUsages({ 'dist/bundle.js': 'process.env.SECRET' })).toEqual([]);
  });
});

describe('reading .env files', () => {
  it('takes the names and ignores the values', () => {
    const keys = parseEnvKeys('DATABASE_URL=postgres://user:pw@host/db\n# a comment\nAPI_KEY=abc');

    expect(keys).toEqual(['DATABASE_URL', 'API_KEY']);
  });

  it('handles an exported assignment', () => {
    expect(parseEnvKeys('export TOKEN=abc')).toEqual(['TOKEN']);
  });

  it('skips comments and blank lines', () => {
    expect(parseEnvKeys('\n# nothing\n\n')).toEqual([]);
  });

  it('separates example files from real ones', () => {
    const found = envFilesIn({ '.env': 'A=1', '.env.example': 'A=your-value' });

    expect(found.find((entry) => entry.path === '.env')?.example).toBe(false);
    expect(found.find((entry) => entry.path === '.env.example')?.example).toBe(true);
  });
});

describe('what is wrong', () => {
  it('reports a variable the code reads that nothing declares', () => {
    const issues = findIssues([], findUsages({ 'src/a.ts': 'process.env.MISSING' }), 'development');

    const undeclared = issues.find((issue) => issue.kind === 'undeclared');
    expect(undeclared?.key).toBe('MISSING');
    expect(undeclared?.severity).toBe('high');
  });

  it('reports a declared variable nothing reads, but quietly', () => {
    const issues = findIssues([variable({ key: 'UNUSED' })], [], 'development');

    expect(issues.find((issue) => issue.kind === 'unused')?.severity).toBe('low');
  });

  /**
   * The label that is worse than no label: somebody trusts "secret" on a value
   * the bundler inlines into every visitor's JavaScript.
   */
  it('reports a secret whose prefix publishes it to every visitor', () => {
    const issues = findIssues(
      [variable({ key: 'VITE_API_KEY', secret: true })],
      findUsages({ 'src/a.ts': 'import.meta.env.VITE_API_KEY' }),
      'development',
    );

    const contradiction = issues.find((issue) => issue.kind === 'secret-published');
    expect(contradiction?.severity).toBe('high');
    expect(contradiction?.message).toMatch(/publishes it to every visitor/i);
  });

  it('does not report a public value that is not claimed to be secret', () => {
    const issues = findIssues(
      [variable({ key: 'VITE_API_URL', secret: false })],
      findUsages({ 'src/a.ts': 'import.meta.env.VITE_API_URL' }),
      'development',
    );

    expect(issues.find((issue) => issue.kind === 'secret-published')).toBeUndefined();
  });

  it('reports a variable the code needs that this environment does not declare', () => {
    const issues = findIssues(
      [variable({ key: 'DATABASE_URL', environments: ['development'] })],
      findUsages({ 'src/a.ts': 'process.env.DATABASE_URL' }),
      'production',
    );

    const missing = issues.find((issue) => issue.kind === 'missing-in-environment');
    expect(missing?.severity).toBe('high');
  });

  it('treats the same gap in preview as less urgent than in production', () => {
    const usages = findUsages({ 'src/a.ts': 'process.env.X' });
    const declared = [variable({ key: 'X', environments: ['development'] })];

    const inPreview = findIssues(declared, usages, 'preview').find(
      (issue) => issue.kind === 'missing-in-environment',
    );
    const inProduction = findIssues(declared, usages, 'production').find(
      (issue) => issue.kind === 'missing-in-environment',
    );

    expect(inPreview?.severity).toBe('medium');
    expect(inProduction?.severity).toBe('high');
  });

  it('puts the urgent issues first', () => {
    const issues = findIssues(
      [variable({ key: 'UNUSED' })],
      findUsages({ 'src/a.ts': 'process.env.MISSING' }),
      'development',
    );

    expect(issues[0].severity).toBe('high');
  });
});

describe('public prefixes', () => {
  it.each(['VITE_X', 'NEXT_PUBLIC_X', 'REACT_APP_X', 'PUBLIC_X'])('recognises %s', (key) => {
    expect(isPublicPrefixed(key)).toBe(true);
  });

  it('leaves an ordinary name alone', () => {
    expect(isPublicPrefixed('DATABASE_URL')).toBe(false);
  });
});

describe('guarding production', () => {
  /** A confirmation on everything becomes a reflex, and the reflex is the problem. */
  it('asks for production and not for the others', () => {
    expect(needsConfirmation('production')).toBe(true);
    expect(needsConfirmation('development')).toBe(false);
    expect(needsConfirmation('preview')).toBe(false);
  });
});

describe('where secrets actually live', () => {
  it('names the place for each environment rather than implying it holds them', () => {
    const variables = [variable({ key: 'TOKEN', secret: true, environments: ['production'] })];

    const status = vaultStatus(variables, 'production');
    expect(status.secretCount).toBe(1);
    expect(status.wherePlaced).toMatch(/deployment platform/i);
    expect(vaultStatus(variables, 'development').wherePlaced).toMatch(/\.env/);
  });
});

describe('the store', () => {
  beforeEach(() => {
    useEnvStore.setState({ variables: [], environment: 'development', pending: null });
    localStorage.removeItem('ta-code-environments');
  });

  /** The refusal that makes the promise real, rather than a hidden field. */
  it('refuses to hold a secret value at all', () => {
    useEnvStore.getState().addVariable('TOKEN');
    useEnvStore.getState().setSecret('TOKEN', true);

    const applied = useEnvStore.getState().setValue('TOKEN', 'tok_live_abc');

    expect(applied).toBe(false);
    expect(useEnvStore.getState().variables[0].value).toBe('');
  });

  it('keeps an ordinary configuration value', () => {
    useEnvStore.getState().addVariable('API_URL');

    expect(useEnvStore.getState().setValue('API_URL', 'https://x.test')).toBe(true);
    expect(useEnvStore.getState().variables[0].value).toBe('https://x.test');
  });

  /** Otherwise a value already typed stays in storage under a "not stored" label. */
  it('drops an existing value when a variable becomes secret', () => {
    useEnvStore.getState().addVariable('API_KEY');
    useEnvStore.getState().setValue('API_KEY', 'plain-for-now');

    useEnvStore.getState().setSecret('API_KEY', true);

    expect(useEnvStore.getState().variables[0].value).toBe('');
  });

  it('never writes a secret value to storage even if one got in', () => {
    useEnvStore.setState({
      variables: [variable({ key: 'TOKEN', secret: true, value: 'tok_live_leak' })],
    });
    // Provoke a persist.
    useEnvStore.getState().setNote('TOKEN', 'note');

    expect(localStorage.getItem('ta-code-environments') ?? '').not.toContain('tok_live_leak');
  });

  it('declares a new variable only for the environment being looked at', () => {
    useEnvStore.getState().setEnvironment('preview');
    useEnvStore.getState().addVariable('X');

    expect(useEnvStore.getState().variables[0].environments).toEqual(['preview']);
  });

  it('does not add the same name twice', () => {
    useEnvStore.getState().addVariable('X');
    useEnvStore.getState().addVariable('X');

    expect(useEnvStore.getState().variables).toHaveLength(1);
  });

  it('applies a change to development immediately', () => {
    let applied = false;
    useEnvStore.getState().guarded('change', () => (applied = true));

    expect(applied).toBe(true);
    expect(useEnvStore.getState().pending).toBeNull();
  });

  it('holds a production change until it is confirmed', () => {
    useEnvStore.getState().setEnvironment('production');
    let applied = false;

    useEnvStore.getState().guarded('remove DATABASE_URL', () => (applied = true));

    expect(applied).toBe(false);
    expect(useEnvStore.getState().pending?.description).toBe('remove DATABASE_URL');

    useEnvStore.getState().confirmPending();
    expect(applied).toBe(true);
  });

  it('does not apply a production change that was declined', () => {
    useEnvStore.getState().setEnvironment('production');
    let applied = false;
    useEnvStore.getState().guarded('drop everything', () => (applied = true));

    useEnvStore.getState().cancelPending();

    expect(applied).toBe(false);
    expect(useEnvStore.getState().pending).toBeNull();
  });
});
