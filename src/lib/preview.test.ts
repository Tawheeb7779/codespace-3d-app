import { describe, expect, it } from 'vitest';
import { findEntry, readDependencyPins } from '@/lib/preview';
import { isBareSpecifier } from '@/lib/bundler';
import { getTemplate, TEMPLATES } from '@/lib/templates';
import { detectProjectLanguage } from '@/lib/languages';

describe('findEntry', () => {
  it('prefers the script index.html actually loads', () => {
    const files = {
      'index.html': '<script type="module" src="./src/boot.js"></script>',
      'src/boot.js': '',
      'src/main.js': '',
    };
    expect(findEntry(files)).toBe('src/boot.js');
  });

  it('ignores remote script tags', () => {
    const files = {
      'index.html': '<script src="https://cdn.example.com/x.js"></script>',
      'src/main.ts': '',
    };
    expect(findEntry(files)).toBe('src/main.ts');
  });

  it('falls back to conventional entry points', () => {
    expect(findEntry({ 'src/main.tsx': '' })).toBe('src/main.tsx');
    expect(findEntry({ 'index.js': '' })).toBe('index.js');
  });

  it('returns null when there is nothing to run', () => {
    expect(findEntry({ 'README.md': '' })).toBeNull();
  });
});

describe('readDependencyPins', () => {
  it('strips range prefixes', () => {
    const pins = readDependencyPins({
      'package.json': JSON.stringify({
        dependencies: { react: '^18.3.1', three: '~0.185.0' },
        devDependencies: { vite: '>=7.0.0' },
      }),
    });
    expect(pins).toEqual({ react: '18.3.1', three: '0.185.0', vite: '7.0.0' });
  });

  it('ignores non-numeric ranges such as git or workspace specifiers', () => {
    const pins = readDependencyPins({
      'package.json': JSON.stringify({ dependencies: { a: 'workspace:*', b: 'github:o/r' } }),
    });
    expect(pins).toEqual({});
  });

  it('tolerates a missing or malformed manifest', () => {
    expect(readDependencyPins({})).toEqual({});
    expect(readDependencyPins({ 'package.json': 'not json' })).toEqual({});
  });
});

describe('bare specifiers', () => {
  it.each(['react', '@scope/pkg', 'lodash/merge'])('treats %s as bare', (spec) => {
    expect(isBareSpecifier(spec)).toBe(true);
  });

  it.each(['./local', '../up', '/root', 'https://cdn/x.js'])('treats %s as resolvable', (spec) => {
    expect(isBareSpecifier(spec)).toBe(false);
  });
});

describe('templates', () => {
  it('every template has a unique id and at least one file or directory', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TEMPLATES) {
      expect(Object.keys(template.files).length + (template.dirs?.length ?? 0)).toBeGreaterThan(0);
    }
  });

  it('non-runnable templates explain why', () => {
    for (const template of TEMPLATES) {
      if (!template.runnable) expect(template.runnableNote).toBeTruthy();
    }
  });

  it('runnable templates expose an entry point the preview can find', () => {
    for (const template of TEMPLATES.filter((t) => t.runnable && t.id !== 'blank')) {
      expect(findEntry(template.files), template.id).not.toBeNull();
    }
  });

  it('every package.json in a template is valid JSON', () => {
    for (const template of TEMPLATES) {
      const manifest = template.files['package.json'];
      if (manifest) expect(() => JSON.parse(manifest), template.id).not.toThrow();
    }
  });

  it('falls back to the blank template for an unknown id', () => {
    expect(getTemplate('nope' as never).id).toBe('blank');
  });
});

describe('detectProjectLanguage', () => {
  it('picks the most common source language, ignoring docs and config', () => {
    expect(
      detectProjectLanguage(['a.ts', 'b.ts', 'c.py', 'README.md', 'package.json']),
    ).toBe('TypeScript');
  });

  it('degrades to plain text when nothing is recognised', () => {
    expect(detectProjectLanguage(['notes.txt'])).toBe('Plain Text');
  });
});
