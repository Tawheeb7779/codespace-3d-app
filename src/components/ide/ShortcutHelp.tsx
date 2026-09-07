import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Field';
import { Kbd } from '@/components/ui/Primitives';
import { formatChord } from '@/hooks/useKeyboardShortcuts';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * What the keyboard can do, read off the keymap rather than written down.
 *
 * A hand-maintained cheat sheet is wrong the moment someone rebinds a key, and
 * wrong forever the moment a binding is added and the sheet is not. This
 * renders `useSettingsStore().keybindings` — the same list the dispatcher reads
 * — so it cannot drift, and a user's own rebindings show up here as theirs.
 *
 * The editor's own shortcuts are not listed. Monaco has hundreds, it has its
 * own F1 palette for them, and reprinting a fraction of them here would suggest
 * that fraction is all there is.
 */

/** Grouping is by what a person is trying to do, not by which store owns it. */
const GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: 'Getting around', ids: ['commandPalette', 'quickOpen', 'search', 'explorer', 'sourceControl'] },
  { title: 'Editing', ids: ['save', 'format', 'closeTab', 'nextTab', 'previousTab', 'splitEditor'] },
  { title: 'The workspace', ids: ['toggleSidebar', 'toggleTerminal', 'togglePreview', 'focusMode'] },
  { title: 'Running and asking', ids: ['run', 'assistant'] },
  { title: 'Help', ids: ['shortcutHelp'] },
];

/**
 * Words people search for that are not in the label.
 *
 * Labels name the thing precisely — "Toggle bottom panel" — and people search
 * for what they call it, which is "terminal". Matching on the label alone means
 * the search box's own placeholder suggests a word that finds nothing. These
 * are search aliases only; nothing here is ever displayed.
 */
const ALIASES: Record<string, string> = {
  toggleTerminal: 'terminal console shell output problems',
  togglePreview: 'preview browser run app',
  commandPalette: 'commands actions everything',
  quickOpen: 'open file go to',
  search: 'find replace grep',
  sourceControl: 'git commit branch diff changes',
  explorer: 'files sidebar tree',
  assistant: 'ai chat ask agent',
  format: 'prettier indent tidy',
  splitEditor: 'side by side pane column',
  focusMode: 'zen distraction free fullscreen',
  run: 'build start preview',
  save: 'write persist',
  closeTab: 'close editor',
  shortcutHelp: 'keys keyboard cheat sheet help',
};

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const keybindings = useSettingsStore((s) => s.keybindings);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byId = new Map(keybindings.map((binding) => [binding.id, binding]));
    const matches = (id: string) => {
      const binding = byId.get(id);
      if (!binding) return false;
      if (!needle) return true;
      const chords = [binding.keys, ...(binding.alternate ?? [])].map(formatChord).join(' ');
      return `${binding.label} ${chords} ${ALIASES[id] ?? ''}`.toLowerCase().includes(needle);
    };
    return GROUPS.map((group) => ({
      title: group.title,
      bindings: group.ids.filter(matches).map((id) => byId.get(id)!),
    })).filter((group) => group.bindings.length > 0);
  }, [keybindings, query]);

  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="lg">
      <Input
        label="Find a shortcut"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="save, terminal, focus…"
      />

      {groups.length === 0 ? (
        <p className="mt-5 text-base text-ink-muted">
          Nothing matches “{query}”. Every shortcut can be rebound in Settings → Keyboard.
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          {groups.map((group) => (
            <section key={group.title}>
              <h3 className="panel-label">{group.title}</h3>
              <ul className="mt-2 overflow-hidden rounded-lg border border-line">
                {group.bindings.map((binding) => (
                  <li
                    key={binding.id}
                    className="flex items-center justify-between gap-4 border-b border-line px-3 py-1.5 last:border-0"
                  >
                    <span className="text-base text-ink">{binding.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Kbd>{formatChord(binding.keys)}</Kbd>
                      {binding.alternate?.map((chord) => (
                        <Kbd key={chord}>{formatChord(chord)}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="mt-5 text-sm text-ink-faint">
        The editor has its own shortcuts on top of these — press F1 with the cursor in a file to
        search them. Anything above can be rebound in Settings → Keyboard.
      </p>
    </Modal>
  );
}
