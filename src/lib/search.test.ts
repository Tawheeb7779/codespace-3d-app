import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEARCH_OPTIONS,
  globToRegExp,
  rankPaths,
  replaceAll,
  searchContents,
  SearchError,
} from '@/lib/search';

const files = {
  'src/App.tsx': 'const title = "Forge";\nexport default title;',
  'src/lib/utils.ts': 'export const title = 1;\n// TODO: revisit',
  'README.md': '# Forge\n\nA title line.',
};

const options = (patch: Partial<typeof DEFAULT_SEARCH_OPTIONS> = {}) => ({
  ...DEFAULT_SEARCH_OPTIONS,
  ...patch,
});

describe('globToRegExp', () => {
  it('matches a single segment with *', () => {
    expect(globToRegExp('*.ts').test('utils.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/utils.ts')).toBe(false);
  });

  it('crosses directories with **', () => {
    const pattern = globToRegExp('**/*.ts');
    expect(pattern.test('src/lib/utils.ts')).toBe(true);
    expect(pattern.test('utils.ts')).toBe(true);
    expect(pattern.test('utils.tsx')).toBe(false);
  });

  it('anchors a rooted pattern', () => {
    const pattern = globToRegExp('src/**/*.css');
    expect(pattern.test('src/a/b.css')).toBe(true);
    expect(pattern.test('other/a.css')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
    expect(globToRegExp('a+b.ts').test('aab.ts')).toBe(false);
  });
});

describe('searchContents', () => {
  it('finds case-insensitive matches by default', () => {
    const result = searchContents(files, options({ query: 'forge' }));
    expect(result.matches.map((m) => m.path).sort()).toEqual(['README.md', 'src/App.tsx']);
  });

  it('respects case sensitivity', () => {
    const result = searchContents(files, options({ query: 'forge', caseSensitive: true }));
    expect(result.matches).toHaveLength(0);
  });

  it('reports accurate line, column and match bounds', () => {
    const result = searchContents(files, options({ query: 'title' }));
    const first = result.matches.find((m) => m.path === 'src/App.tsx');
    expect(first).toMatchObject({ line: 1, column: 7, matchStart: 6, matchEnd: 11 });
  });

  it('honours whole-word matching', () => {
    const result = searchContents(
      { 'a.ts': 'title titles' },
      options({ query: 'title', wholeWord: true }),
    );
    expect(result.matches).toHaveLength(1);
  });

  it('supports regular expressions', () => {
    const result = searchContents(files, options({ query: 'TODO:.*', regex: true }));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].path).toBe('src/lib/utils.ts');
  });

  it('raises a readable error for an invalid pattern', () => {
    expect(() => searchContents(files, options({ query: '(', regex: true }))).toThrow(SearchError);
  });

  it('applies include and exclude filters', () => {
    expect(
      searchContents(files, options({ query: 'title', include: '*.md' })).matches.map((m) => m.path),
    ).toEqual(['README.md']);
    expect(
      searchContents(files, options({ query: 'title', exclude: '*.md' })).matches.every(
        (m) => m.path !== 'README.md',
      ),
    ).toBe(true);
  });

  it('truncates at maxResults', () => {
    const big = { 'a.txt': Array.from({ length: 50 }, () => 'x').join('\n') };
    const result = searchContents(big, options({ query: 'x', maxResults: 10 }));
    expect(result.matches).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it('terminates on a zero-length regex match', () => {
    const result = searchContents({ 'a.txt': 'aaa' }, options({ query: 'b*', regex: true, maxResults: 20 }));
    expect(result.matches.length).toBeLessThanOrEqual(20);
  });
});

describe('replaceAll', () => {
  it('replaces across matching files and reports counts', () => {
    const result = replaceAll(files, options({ query: 'title' }), 'label');
    expect(result.changed.sort()).toEqual(['README.md', 'src/App.tsx', 'src/lib/utils.ts']);
    expect(result.replacements).toBe(4);
    expect(result.files['src/App.tsx']).toContain('const label =');
  });

  it('treats $& literally for non-regex searches', () => {
    const result = replaceAll({ 'a.txt': 'abc' }, options({ query: 'b' }), '$&x');
    expect(result.files['a.txt']).toBe('a$&xc');
  });

  it('supports capture groups in regex mode', () => {
    const result = replaceAll(
      { 'a.txt': 'foo42' },
      options({ query: '([a-z]+)(\\d+)', regex: true }),
      '$2-$1',
    );
    expect(result.files['a.txt']).toBe('42-foo');
  });

  it('can be limited to specific paths', () => {
    const result = replaceAll(files, options({ query: 'title' }), 'label', ['README.md']);
    expect(result.changed).toEqual(['README.md']);
  });
});

describe('rankPaths', () => {
  it('prefers exact substring matches in the basename', () => {
    const ranked = rankPaths(['src/lib/other.ts', 'src/App.tsx', 'app/config.ts'], 'App');
    expect(ranked[0]).toBe('src/App.tsx');
  });

  it('falls back to subsequence matching', () => {
    expect(rankPaths(['src/lib/utils.ts'], 'slu')).toEqual(['src/lib/utils.ts']);
  });

  it('drops non-matches', () => {
    expect(rankPaths(['src/App.tsx'], 'zzzz')).toEqual([]);
  });
});
