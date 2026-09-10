import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  blocksInstall,
  registryStatus,
  validateManifest,
  type Capability,
  type InstalledExtension,
  type ManifestProblem,
} from '@/lib/extensions/registry';

/**
 * What is installed, and what each one is allowed to do.
 *
 * **An install can be refused, and refusing is the point.** A manifest asking
 * for a capability outside the extension boundary — a terminal, the container,
 * the network — is rejected by name rather than installed with that capability
 * quietly dropped. An extension that expected it and silently did not get it
 * fails in ways nobody can explain.
 *
 * **Disabled means disabled.** `grantedTo` returns nothing for a disabled
 * extension, so a host that asks "may this one read files" gets `false` rather
 * than having to remember to check `enabled` first. The check that is easy to
 * forget is the one that must not be the caller's job.
 */

interface ExtensionState {
  installed: InstalledExtension[];
  /** Problems from the last install attempt, for the panel to show. */
  lastProblems: ManifestProblem[];

  install: (raw: unknown) => { ok: boolean; problems: ManifestProblem[] };
  uninstall: (id: string) => void;
  setEnabled: (id: string, enabled: boolean) => void;
  setSetting: (id: string, key: string, value: boolean | string | number) => void;
  clearProblems: () => void;
  /** The capabilities in force for an extension, honouring `enabled`. */
  grantedTo: (id: string) => Capability[];
  registry: () => ReturnType<typeof registryStatus>;
}

export const useExtensionStore = create<ExtensionState>()(
  persist(
    (set, get) => ({
      installed: [],
      lastProblems: [],

      install(raw) {
        const { manifest, problems } = validateManifest(raw);
        set({ lastProblems: problems });

        if (!manifest || blocksInstall(problems)) return { ok: false, problems };
        if (get().installed.some((entry) => entry.manifest.id === manifest.id)) {
          const already: ManifestProblem[] = [
            { kind: 'shape', message: `${manifest.name} is already installed.` },
          ];
          set({ lastProblems: already });
          return { ok: false, problems: already };
        }

        const settings: Record<string, boolean | string | number> = {};
        for (const setting of manifest.settings ?? []) settings[setting.key] = setting.default;

        set((state) => ({
          installed: [
            ...state.installed,
            {
              manifest,
              // Installed disabled. Granting an extension its capabilities the
              // instant it arrives means a decision nobody consciously made.
              enabled: false,
              installedAt: Date.now(),
              settings,
            },
          ],
        }));
        return { ok: true, problems };
      },

      uninstall: (id) =>
        set((state) => ({
          installed: state.installed.filter((entry) => entry.manifest.id !== id),
        })),

      setEnabled: (id, enabled) =>
        set((state) => ({
          installed: state.installed.map((entry) =>
            entry.manifest.id === id ? { ...entry, enabled } : entry,
          ),
        })),

      setSetting: (id, key, value) =>
        set((state) => ({
          installed: state.installed.map((entry) =>
            entry.manifest.id === id
              ? { ...entry, settings: { ...entry.settings, [key]: value } }
              : entry,
          ),
        })),

      clearProblems: () => set({ lastProblems: [] }),

      grantedTo: (id) => {
        const entry = get().installed.find((installed) => installed.manifest.id === id);
        // Disabled grants nothing, decided here rather than left to each caller
        // to remember.
        if (!entry || !entry.enabled) return [];
        return entry.manifest.capabilities;
      },

      registry: () => registryStatus(),
    }),
    {
      name: 'ta-code-extensions',
      // What is installed and how it is configured. Not the last install's
      // problems, which belong to the attempt that produced them.
      partialize: (state) => ({ installed: state.installed }),
    },
  ),
);
