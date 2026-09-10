import { describe, expect, it } from 'vitest';
import {
  architecturePrompt,
  buildGraph,
  groupFor,
  importsIn,
  isolatedNodes,
  outboundHosts,
  resolveImport,
} from '@/lib/architecture/graph';

/**
 * An architecture diagram is only useful if it is a reading of the code.
 *
 * A decorative one is worse than none: it is believed, and then acted on after
 * the code has moved past it. So every node here must come from something the
 * source actually contains, and must carry the evidence that put it there.
 *
 * The corollary is the test that matters most: a project with no backend must
 * draw no backend, and an empty project must draw nothing at all rather than a
 * plausible skeleton.
 */

describe('reading imports', () => {
  it.each([
    ["import x from './a'", './a'],
    ["import './a'", './a'],
    ["const x = require('./a')", './a'],
    ["const x = await import('./a')", './a'],
    ["import { a, b } from '../lib/a'", '../lib/a'],
  ])('finds the specifier in %j', (line, expected) => {
    expect(importsIn(line)).toContain(expected);
  });

  it('finds bare specifiers too', () => {
    expect(importsIn("import React from 'react'")).toContain('react');
  });

  it('lists each specifier once', () => {
    expect(importsIn("import a from './x'\nimport b from './x'")).toEqual(['./x']);
  });
});

describe('resolving an import to a file', () => {
  const files = { 'src/a.ts': '', 'src/b/index.tsx': '', 'src/c.tsx': '' };

  it.each([
    ['src/main.ts', './a', 'src/a.ts'],
    ['src/main.ts', './c', 'src/c.tsx'],
    ['src/main.ts', './b', 'src/b/index.tsx'],
  ])('resolves %s importing %s', (from, specifier, expected) => {
    expect(resolveImport(from, specifier, files)).toBe(expected);
  });

  /** A package is not a file in this project, and is not a node. */
  it('does not resolve a bare specifier', () => {
    expect(resolveImport('src/main.ts', 'react', files)).toBeNull();
  });

  it('returns nothing for a relative import that does not exist', () => {
    expect(resolveImport('src/main.ts', './nowhere', files)).toBeNull();
  });
});

describe('grouping files', () => {
  it.each([
    ['src/components/Button.tsx', 'Components'],
    ['src/stores/x.ts', 'State'],
    ['api/handler.ts', 'API routes'],
    ['supabase/migrations/0001.sql', 'Migrations'],
  ])('puts %s under %s', (path, label) => {
    expect(groupFor(path)?.label).toBe(label);
  });

  /** Longest prefix wins, or an edge function would be filed as a migration. */
  it('prefers the more specific prefix', () => {
    expect(groupFor('supabase/functions/ai/index.ts')?.label).toBe('Edge functions');
  });

  it('leaves an ungrouped file alone', () => {
    expect(groupFor('src/main.tsx')).toBeNull();
  });
});

describe('finding outbound hosts', () => {
  it('finds a hostname in a URL literal', () => {
    expect(outboundHosts('fetch("https://api.stripe.com/v1/charges")')).toEqual(['api.stripe.com']);
  });

  /** A development address is not an architecture edge. */
  it.each(['http://localhost:3000/api', 'http://127.0.0.1:8080/x'])('ignores %s', (url) => {
    expect(outboundHosts(`fetch("${url}")`)).toEqual([]);
  });

  it('lists a host once however often it appears', () => {
    const found = outboundHosts('"https://api.x.test/a" and "https://api.x.test/b"');

    expect(found).toEqual(['api.x.test']);
  });
});

describe('building the graph', () => {
  it('anchors on the entry point the preview builds from', () => {
    const graph = buildGraph({ 'src/main.tsx': 'export default 1;' });

    const entry = graph.nodes.find((node) => node.kind === 'entry');
    expect(entry?.label).toBe('src/main.tsx');
  });

  it('draws an edge for a real import between files', () => {
    const graph = buildGraph({
      'src/main.tsx': "import { App } from './components/App';",
      'src/components/App.tsx': 'export const App = () => null;',
    });

    expect(
      graph.edges.some((edge) => edge.from === 'entry' && edge.kind === 'imports'),
    ).toBe(true);
  });

  it('groups a directory into one node with its members', () => {
    const graph = buildGraph({
      'src/components/A.tsx': 'export const A = 1;',
      'src/components/B.tsx': 'export const B = 1;',
    });

    const group = graph.nodes.find((node) => node.label === 'Components');
    expect(group?.members).toHaveLength(2);
  });

  it('finds a database from the client the code constructs', () => {
    const graph = buildGraph({
      'src/db.ts': "import { createClient } from '@supabase/supabase-js';\nexport const db = createClient(a, b);",
    });

    const database = graph.nodes.find((node) => node.kind === 'database');
    expect(database?.label).toContain('Supabase');
    expect(database?.evidence).toMatch(/createClient/);
  });

  /**
   * The methods people actually call carry a suffix — `signInWithPassword`,
   * `signInWithOAuth`. Matching only the bare name missed both.
   */
  it.each([
    'await client.auth.signInWithPassword(x);',
    'await client.auth.signInWithOAuth(x);',
    'await client.auth.getSession();',
    'client.auth.onAuthStateChange(fn);',
  ])('finds authentication in %j', (line) => {
    expect(buildGraph({ 'src/auth.ts': line }).nodes.some((node) => node.kind === 'auth')).toBe(true);
  });

  it('does not call an unrelated property named auth an auth service', () => {
    const graph = buildGraph({ 'src/a.ts': 'const x = config.auth.enabled;' });

    expect(graph.nodes.some((node) => node.kind === 'auth')).toBe(false);
  });

  it('finds an external API from a URL in the source', () => {
    const graph = buildGraph({ 'src/pay.ts': 'fetch("https://api.stripe.com/v1/x")' });

    const api = graph.nodes.find((node) => node.kind === 'api');
    expect(api?.label).toBe('api.stripe.com');
    expect(api?.line).toBe(1);
  });

  it('finds deployment configuration in the project root', () => {
    const graph = buildGraph({ 'src/main.ts': '', 'vercel.json': '{}' });

    expect(graph.nodes.some((node) => node.kind === 'deployment')).toBe(true);
  });

  /**
   * The property that separates this from a decoration: what is not in the
   * code is not in the picture.
   */
  it('draws no backend for a project that has none', () => {
    const graph = buildGraph({ 'src/main.tsx': 'export default 1;' });

    expect(graph.nodes.some((node) => node.kind === 'backend')).toBe(false);
    expect(graph.nodes.some((node) => node.kind === 'database')).toBe(false);
    expect(graph.nodes.some((node) => node.kind === 'auth')).toBe(false);
  });

  it('draws nothing at all for an empty project', () => {
    const graph = buildGraph({});

    expect(graph.nodes).toEqual([]);
    expect(graph.scannedFiles).toBe(0);
  });

  it('ignores dependencies and build output', () => {
    const graph = buildGraph({
      'node_modules/x/index.js': 'createClient()',
      'dist/bundle.js': 'fetch("https://api.evil.test")',
    });

    expect(graph.nodes).toEqual([]);
  });

  it('gives every node the evidence that produced it', () => {
    const graph = buildGraph({
      'src/main.tsx': "import './a';\nfetch('https://api.x.test')",
      'src/a.ts': 'export const a = 1;',
    });

    for (const node of graph.nodes) expect(node.evidence).toBeTruthy();
  });

  it('does not draw a file depending on itself', () => {
    const graph = buildGraph({ 'src/components/A.tsx': "import './B';", 'src/components/B.tsx': '' });

    expect(graph.edges.some((edge) => edge.from === edge.to)).toBe(false);
  });
});

describe('nodes nothing touches', () => {
  it('names a file nothing imports and which imports nothing', () => {
    const graph = buildGraph({
      'src/main.tsx': "import './a';",
      'src/a.ts': 'export const a = 1;',
      'src/orphan.ts': 'export const orphan = 1;',
    });

    expect(isolatedNodes(graph).some((node) => node.label.includes('orphan'))).toBe(true);
  });
});

describe('asking the agent about it', () => {
  it('carries the derived graph rather than the project name', () => {
    const graph = buildGraph({ 'src/db.ts': 'createClient(a, b)' });
    const prompt = architecturePrompt(graph);

    expect(prompt).toContain('Supabase');
    expect(prompt).toContain('derived from its own files');
  });

  /** The decorative-diagram problem, one layer up. */
  it('tells the agent to say when the graph is too sparse rather than invent', () => {
    const prompt = architecturePrompt(buildGraph({}));

    expect(prompt).toMatch(/too sparse to judge, say that instead of inventing/i);
  });
});
