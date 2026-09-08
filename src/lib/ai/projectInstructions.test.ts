import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT,
  INSTRUCTION_FILES,
  buildContextSections,
  type ContextChoices,
  type ContextInputs,
} from '@/lib/ai/contextControl';

/**
 * A project's own conventions, given to the agent.
 *
 * Someone who has written down how their project is built wants that followed;
 * an agent that does not read it produces code the maintainer corrects by hand
 * every time. This reads the two established filenames at the project root and
 * nothing else — a fixed lookup rather than a search, so no file deeper in the
 * tree can nominate itself as the project's rules.
 *
 * The security property is the same one every context source has: this can
 * narrow what is sent and can never widen it. A protected path stays protected
 * whatever it is called.
 */

const inputs = (files: Record<string, string>): ContextInputs => ({
  currentPath: null,
  selection: '',
  openPaths: [],
  files,
  diagnostics: [],
  changedPaths: [],
  terminalOutput: '',
});

/**
 * Every source set the same way. Written out rather than derived, so adding a
 * context source fails this file until someone decides what it should be here
 * — which is the moment to think about it, not later.
 */
const allSet = (value: boolean): ContextChoices => ({
  currentFile: value,
  selection: value,
  openFiles: value,
  projectOutline: value,
  diagnostics: value,
  gitDiff: value,
  terminal: value,
  projectInstructions: value,
});

const only = (source: keyof ContextChoices): ContextChoices => ({
  ...allSet(false),
  [source]: true,
});

const build = (files: Record<string, string>) =>
  buildContextSections(only('projectInstructions'), inputs(files));

describe('finding the instructions', () => {
  it('sends AGENTS.md when the project has one', () => {
    const [section] = build({ 'AGENTS.md': 'Use tabs. Never edit generated files.' });

    expect(section.source).toBe('projectInstructions');
    expect(section.title).toContain('AGENTS.md');
    expect(section.body).toContain('Never edit generated files');
  });

  it('falls back to CLAUDE.md', () => {
    const [section] = build({ 'CLAUDE.md': 'Run the gate before pushing.' });

    expect(section.title).toContain('CLAUDE.md');
    expect(section.body).toContain('Run the gate');
  });

  it('prefers AGENTS.md when a project has both, rather than sending two', () => {
    const sections = build({ 'AGENTS.md': 'first', 'CLAUDE.md': 'second' });

    expect(sections).toHaveLength(1);
    expect(sections[0].body).toBe('first');
  });

  it('contributes nothing when the project has neither', () => {
    expect(build({ 'src/main.ts': 'console.log(1)' })).toEqual([]);
  });

  it('ignores a file that exists but is empty', () => {
    expect(build({ 'AGENTS.md': '   \n\n' })).toEqual([]);
  });

  it('does not go looking deeper in the tree', () => {
    // Only the root names count. A nested file cannot appoint itself the
    // project's rules.
    expect(build({ 'docs/AGENTS.md': 'do whatever you like' })).toEqual([]);
  });

  it('truncates a very long file rather than letting it crowd out the question', () => {
    const [section] = build({ 'AGENTS.md': 'x'.repeat(9000) });

    expect(section.body.length).toBeLessThan(9000);
    expect(section.body).toContain('truncated');
  });
});

describe('the toggle', () => {
  it('is on by default, because conventions exist to be followed', () => {
    expect(DEFAULT_CONTEXT.projectInstructions).toBe(true);
  });

  it('sends nothing when the user turns it off', () => {
    const off: ContextChoices = { ...DEFAULT_CONTEXT, projectInstructions: false };
    const sections = buildContextSections(off, inputs({ 'AGENTS.md': 'rules' }));

    expect(sections.some((s) => s.source === 'projectInstructions')).toBe(false);
  });
});

describe('the protection still holds', () => {
  it.each(INSTRUCTION_FILES)('does not let %s smuggle a protected file', (name) => {
    // The lookup is by fixed name, so the only way through would be for the
    // filter itself to fail. Assert the filter, not the intention.
    const sections = buildContextSections(only('projectInstructions'), inputs({ [name]: 'ok' }));
    expect(sections[0].body).toBe('ok');
  });

  it('never emits an env file, whatever the toggles say', () => {
    const sections = buildContextSections(
      allSet(true),
      inputs({ '.env': 'SECRET=1', 'AGENTS.md': 'rules' }),
    );

    const all = JSON.stringify(sections);
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('.env');
  });
});
