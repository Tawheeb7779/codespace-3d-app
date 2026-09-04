import { describe, expect, it } from 'vitest';
import { isSensitivePath, readableFiles } from '@/lib/vfs';

/**
 * The bulk-read boundary.
 *
 * `read_file` refusing a protected path is worth nothing if a project-wide
 * search prints the same lines, or a project-wide replace rewrites them. Every
 * caller that walks the whole tree filters through here, so this is the one
 * place that decides what "the whole tree" means.
 */

const tree = {
  'src/app.ts': 'export const app = 1;',
  '.env': 'API_KEY=super-secret',
  '.env.local': 'DB_URL=postgres://secret',
  '.env.example': 'API_KEY=',
  '.git/config': '[remote "origin"]',
  'node_modules/left-pad/index.js': 'module.exports = 1;',
  '.npmrc': '//registry.npmjs.org/:_authToken=secret',
  '.ssh/id_rsa': 'PRIVATE KEY',
  'dist/bundle.js': 'built',
  'README.md': '# hello',
};

describe('readableFiles', () => {
  it('keeps ordinary project files, with their content intact', () => {
    const visible = readableFiles(tree);
    expect(visible['src/app.ts']).toBe('export const app = 1;');
    expect(visible['README.md']).toBe('# hello');
  });

  it('removes every file holding a secret', () => {
    const visible = readableFiles(tree);
    for (const path of ['.env', '.env.local', '.npmrc', '.ssh/id_rsa']) {
      expect(visible, path).not.toHaveProperty(path);
    }
    // Not one secret survives anywhere in the values, either.
    expect(JSON.stringify(visible)).not.toContain('super-secret');
    expect(JSON.stringify(visible)).not.toContain('_authToken');
  });

  it('removes VCS internals, dependencies and build output', () => {
    const visible = readableFiles(tree);
    expect(visible).not.toHaveProperty('.git/config');
    expect(visible).not.toHaveProperty('node_modules/left-pad/index.js');
    expect(visible).not.toHaveProperty('dist/bundle.js');
  });

  /** The sample files exist precisely so they can be read and copied. */
  it('keeps the secret-free samples', () => {
    expect(readableFiles(tree)).toHaveProperty(['.env.example']);
    expect(isSensitivePath('.env.example')).toBe(false);
    expect(isSensitivePath('config/.env.sample')).toBe(false);
    expect(isSensitivePath('.env.template')).toBe(false);
  });

  it('applies the policy at any depth, not just the project root', () => {
    const nested = readableFiles({
      'packages/api/.env': 'SECRET=1',
      'packages/api/src/index.ts': 'ok',
      'apps/web/node_modules/x/index.js': 'dep',
    });
    expect(Object.keys(nested)).toEqual(['packages/api/src/index.ts']);
  });

  it('never invents a file that was not there', () => {
    expect(readableFiles({})).toEqual({});
  });
});
