import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '@/routes/SettingsPage';

/**
 * One control per setting.
 *
 * Auto save was rendered twice — once under Editor and once under Workspace —
 * bound to the same `editor.autoSave` boolean but described two different
 * ways. Two switches for one value reads as two settings, and a reader has no
 * way to tell which description is true or what the other switch does that
 * this one does not.
 *
 * The sweep walks every section in one render, because the page shows one
 * section at a time and that is exactly why nobody noticed. Counting across
 * separate renders would count each render's copy, which is a bug this test
 * had before it had a result.
 */

const SECTIONS = [
  'Editor',
  'Appearance',
  'Terminal',
  'Runtime',
  'Source control',
  'Assistant',
  'Workspace',
  'Integrations',
  'Keyboard',
  'Account',
];

/** How many controls carry each label, summed over every section, once. */
function sweep(labels: RegExp[]): Map<RegExp, number> {
  render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );

  const counts = new Map(labels.map((label) => [label, 0]));
  for (const section of SECTIONS) {
    const tab = screen.queryAllByRole('button', { name: new RegExp(`^${section}$`, 'i') })[0];
    if (!tab) continue;
    fireEvent.click(tab);
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + screen.queryAllByLabelText(label).length);
    }
  }
  return counts;
}

const AUTO_SAVE = /^Auto save$/i;
const FORMAT_ON_SAVE = /^Format on save$/i;
const MINIMAP = /^Minimap$/i;

describe('a setting appears once', () => {
  it('offers Auto save exactly once across the whole page', () => {
    expect(sweep([AUTO_SAVE]).get(AUTO_SAVE)).toBe(1);
  });

  /** Removing the duplicate must not have removed the setting. */
  it('still offers it somewhere', () => {
    expect(sweep([AUTO_SAVE]).get(AUTO_SAVE)).toBeGreaterThan(0);
  });

  it('does not duplicate the other editor switches either', () => {
    const counts = sweep([FORMAT_ON_SAVE, MINIMAP]);

    expect(counts.get(FORMAT_ON_SAVE)).toBeLessThanOrEqual(1);
    expect(counts.get(MINIMAP)).toBeLessThanOrEqual(1);
  });
});
