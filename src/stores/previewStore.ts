import { create } from 'zustand';
import type { DevicepreSet } from '@/types';
import { buildPreview } from '@/lib/preview';
import type { BuildDiagnostic } from '@/lib/bundler';
import { useFileStore } from '@/stores/fileStore';
import { consoleLog, useConsoleStore } from '@/stores/consoleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { errorMessage } from '@/lib/utils';

export type PreviewStatus = 'idle' | 'building' | 'running' | 'error';

interface PreviewState {
  status: PreviewStatus;
  /** Document currently rendered inside the sandboxed iframe. */
  document: string;
  entry: string;
  errors: BuildDiagnostic[];
  warnings: BuildDiagnostic[];
  /** Bare specifiers compiled in from the locally hosted runtime. */
  bundledPackages: string[];
  /** Bare specifiers the preview fetches from the package CDN. */
  externals: string[];
  /**
   * Identity of the file map the current preview was built from. The panel
   * compares against it so a rebuild happens on a real edit and not on the
   * store's own status transitions.
   */
  builtFrom: Record<string, string> | null;
  device: DevicepreSet;
  lastBuildMs: number;
  buildToken: number;
  run: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  setDevice: (device: DevicepreSet) => void;
}

export const DEVICE_SIZES: Record<DevicepreSet, { width: number; height: number; label: string }> = {
  desktop: { width: 0, height: 0, label: 'Responsive' },
  tablet: { width: 834, height: 1112, label: '834 × 1112' },
  mobile: { width: 390, height: 844, label: '390 × 844' },
};

let running = false;

export const usePreviewStore = create<PreviewState>()((set, get) => ({
  status: 'idle',
  document: '',
  entry: '',
  errors: [],
  warnings: [],
  bundledPackages: [],
  externals: [],
  builtFrom: null,
  device: 'desktop',
  lastBuildMs: 0,
  buildToken: 0,

  async run() {
    if (running) return;
    running = true;
    const { clearConsoleOnRun } = useSettingsStore.getState().runtime;
    set({ status: 'building' });
    try {
      const files = useFileStore.getState().files;
      set({ builtFrom: files });
      const result = await buildPreview(files);
      if (clearConsoleOnRun) {
        // Keep build diagnostics; drop stale runtime noise from the last run.
        useConsoleStore.setState((state) => ({
          entries: state.entries.filter((entry) => entry.channel !== 'preview'),
        }));
      }
      for (const warning of result.warnings) {
        consoleLog.build(`${warning.path}:${warning.line} ${warning.message}`, 'warn');
      }
      for (const error of result.errors) {
        consoleLog.build(`${error.path}:${error.line} ${error.message}`, 'error');
      }
      if (!result.errors.length && result.entry) {
        consoleLog.build(`Built ${result.entry} in ${result.durationMs}ms`, 'info');
        if (result.bundledPackages.length) {
          consoleLog.build(
            `Bundled locally (no network): ${result.bundledPackages.join(', ')}`,
            'info',
          );
        }
        if (result.externals.length) {
          consoleLog.build(
            `Loaded from ${useSettingsStore.getState().runtime.esmCdn}: ${result.externals.join(', ')}`,
            'info',
          );
        }
      }
      set({
        document: result.html,
        entry: result.entry,
        errors: result.errors,
        warnings: result.warnings,
        bundledPackages: result.bundledPackages,
        externals: result.externals,
        lastBuildMs: result.durationMs,
        status: result.errors.length ? 'error' : 'running',
        buildToken: get().buildToken + 1,
      });
    } catch (error) {
      const message = errorMessage(error);
      consoleLog.build(message, 'error');
      set({
        status: 'error',
        errors: [{ path: '', line: 1, column: 1, message, severity: 'error' }],
      });
    } finally {
      running = false;
    }
  },

  stop() {
    set({ status: 'idle', document: '', builtFrom: null, buildToken: get().buildToken + 1 });
    consoleLog.build('Preview stopped', 'info');
  },

  async refresh() {
    if (get().status === 'idle') return get().run();
    // Re-emit the same document with a new token to force a full reload.
    set({ buildToken: get().buildToken + 1 });
  },

  setDevice: (device) => set({ device }),
}));
