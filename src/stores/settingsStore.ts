import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeName = 'forge-dark' | 'forge-light' | 'system';
export type Density = 'comfortable' | 'compact';

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  autoSave: boolean;
  autoSaveDelay: number;
  formatOnSave: boolean;
  bracketPairColorization: boolean;
  fontFamily: string;
}

export interface AppearanceSettings {
  theme: ThemeName;
  density: Density;
  reducedMotion: boolean;
}

export interface RuntimeSettings {
  autoRun: boolean;
  reloadOnSave: boolean;
  clearConsoleOnRun: boolean;
  devServerPort: number;
  /** Where the preview resolves bare imports from. */
  esmCdn: EsmCdn;
}

/**
 * The preview has no node_modules, so bare imports resolve over the network.
 * Offering a choice matters: corporate networks and offline setups block one
 * CDN but not another, and a project with no dependencies needs neither.
 */
export type EsmCdn = 'esm.sh' | 'jsdelivr';

export const ESM_CDN_URLS: Record<EsmCdn, (spec: string) => string> = {
  'esm.sh': (spec) => `https://esm.sh/${spec}`,
  jsdelivr: (spec) => `https://cdn.jsdelivr.net/npm/${spec}/+esm`,
};

export interface Keybinding {
  id: string;
  label: string;
  keys: string;
}

/**
 * Default keymap. `keys` is a normalised chord ("mod" = Cmd on macOS, Ctrl
 * elsewhere) so a rebind is just a string change; the dispatcher in
 * `useKeyboardShortcuts` reads this list rather than hard-coding combinations.
 */
export const DEFAULT_KEYBINDINGS: Keybinding[] = [
  { id: 'commandPalette', label: 'Command palette', keys: 'mod+k' },
  { id: 'quickOpen', label: 'Quick open file', keys: 'mod+p' },
  { id: 'save', label: 'Save file', keys: 'mod+s' },
  { id: 'toggleTerminal', label: 'Toggle bottom panel', keys: 'mod+j' },
  { id: 'toggleSidebar', label: 'Toggle sidebar', keys: 'mod+b' },
  { id: 'togglePreview', label: 'Toggle preview', keys: 'mod+alt+p' },
  { id: 'search', label: 'Search across files', keys: 'mod+shift+f' },
  { id: 'closeTab', label: 'Close editor tab', keys: 'mod+w' },
  { id: 'run', label: 'Run project', keys: 'mod+enter' },
  { id: 'format', label: 'Format document', keys: 'mod+shift+i' },
];

interface SettingsState {
  editor: EditorSettings;
  appearance: AppearanceSettings;
  runtime: RuntimeSettings;
  keybindings: Keybinding[];
  setEditor: (patch: Partial<EditorSettings>) => void;
  setAppearance: (patch: Partial<AppearanceSettings>) => void;
  setRuntime: (patch: Partial<RuntimeSettings>) => void;
  setKeybinding: (id: string, keys: string) => void;
  resetKeybindings: () => void;
  resetAll: () => void;
}

const DEFAULT_EDITOR: EditorSettings = {
  fontSize: 13,
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  lineNumbers: true,
  autoSave: true,
  autoSaveDelay: 800,
  formatOnSave: false,
  bracketPairColorization: true,
  fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
};

const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'forge-dark',
  density: 'comfortable',
  reducedMotion: false,
};

const DEFAULT_RUNTIME: RuntimeSettings = {
  autoRun: true,
  reloadOnSave: true,
  clearConsoleOnRun: true,
  devServerPort: 5173,
  esmCdn: 'esm.sh',
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      editor: DEFAULT_EDITOR,
      appearance: DEFAULT_APPEARANCE,
      runtime: DEFAULT_RUNTIME,
      keybindings: DEFAULT_KEYBINDINGS,

      setEditor: (patch) => set((state) => ({ editor: { ...state.editor, ...patch } })),
      setAppearance: (patch) =>
        set((state) => ({ appearance: { ...state.appearance, ...patch } })),
      setRuntime: (patch) => set((state) => ({ runtime: { ...state.runtime, ...patch } })),
      setKeybinding: (id, keys) =>
        set((state) => ({
          keybindings: state.keybindings.map((b) => (b.id === id ? { ...b, keys } : b)),
        })),
      resetKeybindings: () => set({ keybindings: DEFAULT_KEYBINDINGS }),
      resetAll: () =>
        set({
          editor: DEFAULT_EDITOR,
          appearance: DEFAULT_APPEARANCE,
          runtime: DEFAULT_RUNTIME,
          keybindings: DEFAULT_KEYBINDINGS,
        }),
    }),
    {
      name: 'forge.settings',
      version: 1,
      // Merge stored settings over defaults so a new setting added in a release
      // does not come back undefined for existing users.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...saved,
          editor: { ...current.editor, ...(saved.editor ?? {}) },
          appearance: { ...current.appearance, ...(saved.appearance ?? {}) },
          runtime: { ...current.runtime, ...(saved.runtime ?? {}) },
          keybindings: DEFAULT_KEYBINDINGS.map(
            (binding) => saved.keybindings?.find((b) => b.id === binding.id) ?? binding,
          ),
        };
      },
    },
  ),
);
