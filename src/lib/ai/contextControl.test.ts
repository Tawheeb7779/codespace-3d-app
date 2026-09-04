// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildContextSections,
  contextSize,
  DEFAULT_CONTEXT,
  renderContextSections,
  type ContextChoices,
  type ContextInputs,
} from '@/lib/ai/contextControl';

/**
 * What leaves the browser for the model.
 *
 * The load-bearing property is asymmetric: these toggles may narrow what is
 * sent and must never widen it. A user who ticks every box still cannot cause
 * a protected file to be transmitted — not its content, and not even its name,
 * since a file list is itself a disclosure of what exists.
 */

const ALL_ON: ContextChoices = {
  currentFile: true,
  selection: true,
  openFiles: true,
  projectOutline: true,
  diagnostics: true,
  gitDiff: true,
  terminal: true,
};

const ALL_OFF: ContextChoices = {
  currentFile: false,
  selection: false,
  openFiles: false,
  projectOutline: false,
  diagnostics: false,
  gitDiff: false,
  terminal: false,
};

const inputs = (overrides: Partial<ContextInputs> = {}): ContextInputs => ({
  currentPath: 'src/app.ts',
  selection: 'const x = 1;',
  openPaths: ['src/app.ts', '.env', 'node_modules/dep/index.js', 'README.md'],
  files: {
    'src/app.ts': 'const x = 1;',
    'README.md': '# hi',
    '.env': 'API_KEY=super-secret',
    'node_modules/dep/index.js': 'module.exports = 1;',
  },
  diagnostics: ['src/app.ts:1 error: boom'],
  changedPaths: ['src/app.ts', '.env'],
  terminalOutput: 'npm run build\nok',
  ...overrides,
});

const bodies = (choices: ContextChoices, i = inputs()) =>
  renderContextSections(buildContextSections(choices, i));

describe('the security boundary is not a preference', () => {
  it('never names a protected file, even with every source enabled', () => {
    const text = bodies(ALL_ON);
    expect(text).not.toContain('.env');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('super-secret');
  });

  it('drops a protected current file rather than sending its path', () => {
    const sections = buildContextSections(ALL_ON, inputs({ currentPath: '.env' }));
    expect(sections.some((section) => section.source === 'currentFile')).toBe(false);
  });

  it('drops protected paths from the changed-files list', () => {
    const sections = buildContextSections(ALL_ON, inputs());
    const diff = sections.find((section) => section.source === 'gitDiff');
    expect(diff?.body).toBe('src/app.ts');
  });

  it('drops a path that is open but no longer in the project', () => {
    const sections = buildContextSections(ALL_ON, inputs({ openPaths: ['src/gone.ts'] }));
    expect(sections.some((section) => section.source === 'openFiles')).toBe(false);
  });
});

describe('the toggles decide what is sent', () => {
  it('sends nothing when everything is off', () => {
    expect(buildContextSections(ALL_OFF, inputs())).toEqual([]);
    expect(bodies(ALL_OFF)).toBe('');
  });

  it('sends each source only when it is on', () => {
    const only = { ...ALL_OFF, terminal: true };
    const sections = buildContextSections(only, inputs());
    expect(sections.map((section) => section.source)).toEqual(['terminal']);
    expect(sections[0].body).toContain('npm run build');
  });

  it('omits a source that is on but has nothing to say', () => {
    const sections = buildContextSections(ALL_ON, inputs({ selection: '   ', diagnostics: [] }));
    const sources = sections.map((section) => section.source);
    expect(sources).not.toContain('selection');
    expect(sources).not.toContain('diagnostics');
  });

  it('keeps the defaults cheap: no terminal buffer, no diff', () => {
    const sources = buildContextSections(DEFAULT_CONTEXT, inputs()).map((s) => s.source);
    expect(sources).not.toContain('terminal');
    expect(sources).not.toContain('gitDiff');
    expect(sources).toContain('currentFile');
  });
});

describe('size is bounded', () => {
  it('truncates a huge selection rather than sending it whole', () => {
    const sections = buildContextSections(ALL_ON, inputs({ selection: 'x'.repeat(50_000) }));
    const selection = sections.find((section) => section.source === 'selection');
    expect(selection?.body.length).toBeLessThan(5000);
    expect(selection?.body).toContain('truncated');
  });

  it('truncates terminal output', () => {
    const sections = buildContextSections(ALL_ON, inputs({ terminalOutput: 'y'.repeat(50_000) }));
    const terminal = sections.find((section) => section.source === 'terminal');
    expect(terminal?.body.length).toBeLessThan(2500);
  });

  it('reports the real size of what will be sent', () => {
    const sections = buildContextSections(ALL_ON, inputs());
    const rendered = renderContextSections(sections);
    expect(contextSize(sections)).toBeGreaterThan(0);
    // The estimate tracks the body text, ignoring the headings around it.
    expect(contextSize(sections)).toBeLessThanOrEqual(rendered.length);
  });
});
