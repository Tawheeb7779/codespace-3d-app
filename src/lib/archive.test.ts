import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { exportZip, importZip, parseRepoSpec, safeArchiveName, stripCommonRoot } from '@/lib/archive';

async function zipOf(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('importZip', () => {
  it('imports plain text files', async () => {
    const report = await importZip(await zipOf({ 'src/a.ts': 'const a = 1;' }));
    expect(report.files).toEqual({ 'src/a.ts': 'const a = 1;' });
    expect(report.skipped).toHaveLength(0);
  });

  it('strips a shared top-level folder, as GitHub zipballs use', async () => {
    const report = await importZip(
      await zipOf({ 'repo-main/src/a.ts': 'a', 'repo-main/README.md': 'b' }),
    );
    expect(Object.keys(report.files).sort()).toEqual(['README.md', 'src/a.ts']);
  });

  // An archive controls its own paths: this is the traversal defence.
  it('refuses entries that escape the project root', async () => {
    const report = await importZip(
      await zipOf({ 'ok.ts': 'x', '../../../etc/passwd': 'root:x:0:0' }),
    );
    expect(Object.keys(report.files)).toEqual(['ok.ts']);
    expect(report.skipped.some((entry) => entry.path.includes('passwd'))).toBe(true);
  });

  it('blocks VCS internals, dependencies and secrets', async () => {
    const report = await importZip(
      await zipOf({
        'src/a.ts': 'ok',
        '.git/config': 'secret',
        '.env': 'API_KEY=leak',
        'node_modules/react/index.js': 'x',
        'dist/bundle.js': 'x',
      }),
    );
    expect(Object.keys(report.files)).toEqual(['src/a.ts']);
    // JSZip also emits implicit directory entries, so assert on the paths.
    const skipped = report.skipped.map((entry) => entry.path);
    expect(skipped).toEqual(
      expect.arrayContaining(['.git/config', '.env', 'node_modules/react/index.js', 'dist/bundle.js']),
    );
    expect(skipped).not.toContain('src/a.ts');
  });

  it('skips binaries rather than corrupting them', async () => {
    const report = await importZip(await zipOf({ 'a.ts': 'ok', 'logo.png': 'binary-ish' }));
    expect(Object.keys(report.files)).toEqual(['a.ts']);
    expect(report.skipped[0].reason).toMatch(/Binary/);
  });

  it('rejects an archive with nothing importable', async () => {
    await expect(importZip(await zipOf({ '.env': 'secret' }))).rejects.toThrow(
      /No importable files/,
    );
  });

  it('rejects an empty archive', async () => {
    await expect(importZip(await zipOf({}))).rejects.toThrow(/empty/);
  });
});

describe('exportZip', () => {
  it('omits sensitive paths from the archive', async () => {
    const blob = await exportZip('My Project', {
      'src/a.ts': 'ok',
      '.env': 'API_KEY=leak',
      'node_modules/x/index.js': 'x',
    });
    // jsdom Blobs lack arrayBuffer(); JSZip reads the Blob directly.
    const zip = await JSZip.loadAsync(blob);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
    expect(names).toEqual(['my-project/src/a.ts']);
  });

  it('round-trips through import', async () => {
    const original = { 'src/a.ts': 'const a = 1;', 'README.md': '# Title' };
    const blob = await exportZip('demo', original);
    const report = await importZip(blob);
    expect(report.files).toEqual(original);
  });
});

describe('helpers', () => {
  it('slugifies archive names', () => {
    expect(safeArchiveName('My Cool Project!')).toBe('my-cool-project');
    expect(safeArchiveName('   ')).toBe('forge-project');
  });

  it('leaves distinct top-level folders alone', () => {
    const strip = stripCommonRoot(['a/x.ts', 'b/y.ts']);
    expect(strip('a/x.ts')).toBe('a/x.ts');
  });

  it('parses repository specs', () => {
    expect(parseRepoSpec('vercel/next.js')).toMatchObject({ owner: 'vercel', repo: 'next.js' });
    expect(parseRepoSpec('https://github.com/vercel/next.js')).toMatchObject({
      owner: 'vercel',
      repo: 'next.js',
    });
    expect(parseRepoSpec('https://github.com/a/b/tree/dev')).toMatchObject({ ref: 'dev' });
    expect(() => parseRepoSpec('not a repo')).toThrow();
  });
});
