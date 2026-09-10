import { create } from 'zustand';
import type { DevicepreSet } from '@/types';
import {
  clampDimension,
  viewportFor,
  type Orientation,
  type Viewport,
} from '@/lib/preview/devices';
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
  /**
   * Which viewport the preview renders at.
   *
   * A preset id from `DEVICE_PRESETS` rather than the old three-value union:
   * the ids `desktop`, `tablet` and `mobile` are still in that list, so
   * anything that set one of them keeps working and means the same thing.
   */
  device: string;
  orientation: Orientation;
  /** An exact size, when somebody typed one. Overrides the preset. */
  customViewport: { width: number; height: number } | null;
  lastBuildMs: number;
  buildToken: number;
  run: () => Promise<void>;
  /** One build, from the files as they are now. Sequenced by `run`. */
  buildOnce: () => Promise<void>;
  stop: () => void;
  refresh: () => Promise<void>;
  setDevice: (device: string) => void;
  setOrientation: (orientation: Orientation) => void;
  /** Pass null to go back to the chosen preset. */
  setCustomViewport: (size: { width: number; height: number } | null) => void;
  /** The size to render at, resolved from preset, orientation and custom. */
  viewport: () => Viewport;
}

/**
 * The original three sizes.
 *
 * Kept so nothing that imported it breaks; `viewport()` is what the panel
 * reads now, because it also knows about orientation and a custom size.
 */
export const DEVICE_SIZES: Record<DevicepreSet, { width: number; height: number; label: string }> = {
  desktop: { width: 0, height: 0, label: 'Responsive' },
  tablet: { width: 834, height: 1112, label: '834 × 1112' },
  mobile: { width: 390, height: 844, label: '390 × 844' },
};

/** A build is in flight, so `run` must not start a second one alongside it. */
let running = false;
/**
 * Which build the store is waiting for.
 *
 * `buildPreview` takes as long as the project takes, and in that window the
 * user can stop the preview. The result then arrived and put the document and
 * the running status back, so a preview the user had dismissed reappeared
 * showing the code as it was before they stopped it. Every write below is
 * therefore conditional on the build still being the one that was asked for;
 * `stop` moves this on, which is what makes an outstanding build irrelevant.
 */
let generation = 0;
/**
 * A run asked for while one was already going.
 *
 * Returning early used to be the whole answer, and it lost the request: the
 * panel only asks again when the file map changes, so an edit saved during a
 * build left the preview on the older bundle with nothing to bring it forward.
 * Remembering it here rebuilds once, on the newest files, however many requests
 * arrived meanwhile.
 */
let queued = false;

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
  orientation: 'portrait',
  customViewport: null,
  lastBuildMs: 0,
  buildToken: 0,

  async run() {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      // A request that arrived during a build is served here, once, on
      // whatever the files are by then.
      do {
        queued = false;
        await get().buildOnce();
      } while (queued);
    } finally {
      running = false;
    }
  },

  async buildOnce() {
    const mine = ++generation;
    const { clearConsoleOnRun } = useSettingsStore.getState().runtime;
    set({ status: 'building' });
    try {
      const files = useFileStore.getState().files;
      set({ builtFrom: files });
      const result = await buildPreview(files);
      // Past this point the build may no longer be the one anyone is waiting
      // for: `stop` and a newer request both move the generation on. Say
      // nothing and write nothing.
      if (mine !== generation) return;
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
      if (mine !== generation) return;
      const message = errorMessage(error);
      consoleLog.build(message, 'error');
      set({
        status: 'error',
        errors: [{ path: '', line: 1, column: 1, message, severity: 'error' }],
      });
    }
  },

  stop() {
    // Whatever is still building belongs to a preview the user has dismissed,
    // and a rebuild queued behind it was for the same one.
    generation++;
    queued = false;
    set({ status: 'idle', document: '', builtFrom: null, buildToken: get().buildToken + 1 });
    consoleLog.build('Preview stopped', 'info');
  },

  async refresh() {
    if (get().status === 'idle') return get().run();
    // Re-emit the same document with a new token to force a full reload.
    set({ buildToken: get().buildToken + 1 });
  },

  // Choosing a preset clears a custom size: the two are alternatives, and
  // leaving the custom one in force would make the preset click do nothing.
  setDevice: (device) => set({ device, customViewport: null }),

  setOrientation: (orientation) => set({ orientation }),

  setCustomViewport: (size) =>
    set({
      customViewport: size
        ? { width: clampDimension(size.width), height: clampDimension(size.height) }
        : null,
    }),

  viewport: () => {
    const { device, orientation, customViewport } = get();
    return viewportFor(device, orientation, customViewport);
  },
}));
