import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ExternalLink,
  Monitor,
  Play,
  RotateCw,
  Smartphone,
  Square,
  Tablet,
  TerminalSquare,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Badge, EmptyState } from '@/components/ui/Primitives';
import { usePreviewStore } from '@/stores/previewStore';
import { Menu } from '@/components/ui/Menu';
import {
  CUSTOM_LIMITS,
  DEVICE_PRESETS,
  fitScale,
  presetById,
  viewportFor,
} from '@/lib/preview/devices';
import { useFileStore } from '@/stores/fileStore';
import { useUIStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { consoleLog } from '@/stores/consoleStore';
import { toast } from '@/stores/toastStore';
import { getTemplate } from '@/lib/templates';
import { PREVIEW_SANDBOX, openPreviewWindow } from '@/lib/previewWindow';
import type { ConsoleLevel } from '@/types';
import { cx } from '@/lib/utils';

/**
 * The toolbar's icon, showing what kind of thing is being previewed.
 *
 * Reading the group rather than the id, so a preset added to the list gets the
 * right icon without this having to learn its name.
 */
function DeviceIcon({ device, className }: { device: string; className?: string }) {
  const group = presetById(device)?.group ?? 'desktop';
  const Icon = group === 'phone' ? Smartphone : group === 'tablet' ? Tablet : Monitor;
  return <Icon aria-hidden className={className} />;
}


/**
 * The live preview.
 *
 * The iframe is sandboxed to `allow-scripts` only: no same-origin access, so
 * project code cannot reach the IDE's storage or DOM. Console output arrives by
 * postMessage and is accepted only when it comes from this exact frame.
 */
export function PreviewPanel() {
  const {
    status,
    document: doc,
    entry,
    errors,
    device,
    orientation,
    customViewport,
    lastBuildMs,
    buildToken,
    run,
    stop,
    refresh,
    setDevice,
    setOrientation,
    setCustomViewport,
  } =
    usePreviewStore();
  const files = useFileStore((s) => s.files);
  const dirty = useFileStore((s) => s.dirty);
  const template = useFileStore((s) => s.meta?.template);
  const name = useFileStore((s) => s.meta?.name);
  const setBottomTab = useUIStore((s) => s.setBottomTab);
  const runtime = useSettingsStore((s) => s.runtime);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const blueprint = template ? getTemplate(template) : null;
  const previewSupported = blueprint?.runnable ?? true;

  // Console bridge: only messages from our own frame are trusted.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; level?: string; message?: string } | null;
      if (!data || data.source !== 'forge-preview') return;
      if (data.level === 'ready') return;
      consoleLog.preview(String(data.message ?? ''), (data.level as ConsoleLevel) ?? 'log');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Auto-rebuild after edits settle, when enabled.
  //
  // `status` is deliberately not a dependency, and the guard compares the file
  // map the preview was actually built from. Re-running on every status change
  // made the preview rebuild itself in a loop: each build flipped the status,
  // which re-fired this effect, which scheduled another build.
  useEffect(() => {
    if (!runtime.reloadOnSave || dirty.size) return;
    const state = usePreviewStore.getState();
    if (state.status === 'idle') return;
    if (state.builtFrom === files) return;
    const timer = setTimeout(() => void run(), 400);
    return () => clearTimeout(timer);
  }, [files, dirty.size, runtime.reloadOnSave, run]);

  /*
   * Built here, not in a selector.
   *
   * `usePreviewStore((s) => s.viewport())` returns a fresh object on every
   * call, so zustand's reference check never matches and the component
   * re-renders forever — React error #185. The inputs are primitives and
   * compare equal, so subscribing to those and deriving the viewport is both
   * correct and cheaper.
   */
  const viewport = useMemo(
    () => viewportFor(device, orientation, customViewport),
    [device, orientation, customViewport],
  );

  /*
   * Shrink the frame when it does not fit, never grow it.
   *
   * A 1440-wide viewport in a 500-wide panel is a scrollbar, not a preview.
   * Scaling down shows the whole layout, which is the question being asked;
   * scaling *up* would blow a 390px phone across a monitor and misrepresent
   * how large its text actually is.
   */
  const [deviceMenu, setDeviceMenu] = useState<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = stageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () =>
      setStage({ width: element.clientWidth - 32, height: element.clientHeight - 32 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale = viewport.responsive ? 1 : fitScale(viewport, stage);

  const frameStyle = useMemo<CSSProperties>(
    () =>
      viewport.responsive
        ? { width: '100%', height: '100%' }
        : {
            width: viewport.width,
            height: viewport.height,
            // The frame keeps its real pixel size and is scaled visually, so
            // the page inside still sees the viewport it is being tested at.
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: 'center center',
            flexShrink: 0,
          },
    [viewport, scale],
  );

  const openInTab = () => {
    if (!doc) return;
    const result = openPreviewWindow(doc, `${name ?? 'Preview'} — TA CODE preview`);
    if (result === 'blocked') {
      toast.warning('Popup blocked', 'Allow popups for this site to open the preview.');
    } else if (result === 'unavailable') {
      toast.error('Could not open the preview', 'This browser refused to open a new tab.');
    }
  };

  return (
    <section aria-label="Live preview" className="flex h-full min-w-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        {status === 'running' || status === 'building' ? (
          <IconButton
            label="Stop the preview"
            icon={<Square className="h-3.5 w-3.5" />}
            onClick={stop}
          />
        ) : (
          <IconButton
            label="Run the project"
            icon={<Play className="h-3.5 w-3.5" />}
            disabled={!previewSupported}
            onClick={() => void run()}
          />
        )}
        <IconButton
          label="Reload the preview"
          icon={<RotateCw className="h-3.5 w-3.5" />}
          disabled={status === 'idle'}
          onClick={() => void refresh()}
        />

        <div className="mx-1 h-4 w-px bg-line" />

        {/* Every viewport worth checking, in one menu rather than three
            buttons: the three that fit on a toolbar are not the three that
            catch layout bugs. */}
        <IconButton
          label="Choose a viewport"
          icon={<DeviceIcon device={device} className="h-3.5 w-3.5" />}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setDeviceMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        />
        <Menu
          label="Viewport"
          anchor={deviceMenu}
          onClose={() => setDeviceMenu(null)}
          items={DEVICE_PRESETS.map((preset, index) => ({
            id: preset.id,
            label:
              preset.width === 0 ? preset.label : `${preset.label} · ${preset.width}×${preset.height}`,
            // A rule between the groups, so phones and tablets do not read as
            // one undifferentiated list.
            separatorBefore: index > 0 && preset.group !== DEVICE_PRESETS[index - 1].group,
            onSelect: () => setDevice(preset.id),
          }))}
        />

        <IconButton
          label={orientation === 'portrait' ? 'Rotate to landscape' : 'Rotate to portrait'}
          icon={<RotateCw className="h-3.5 w-3.5" />}
          active={orientation === 'landscape'}
          // Nothing to rotate on a responsive frame or a desktop monitor.
          disabled={viewport.responsive || !(presetById(device)?.rotatable ?? false)}
          onClick={() => setOrientation(orientation === 'portrait' ? 'landscape' : 'portrait')}
        />

        <label className="flex items-center gap-1 text-sm text-ink-faint">
          <span className="sr-only">Custom viewport width</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Custom viewport width"
            placeholder="W"
            min={CUSTOM_LIMITS.min}
            max={CUSTOM_LIMITS.max}
            value={customViewport?.width ?? ''}
            onChange={(event) => {
              const width = Number(event.target.value);
              if (!event.target.value) return setCustomViewport(null);
              setCustomViewport({ width, height: customViewport?.height ?? (viewport.height || 800) });
            }}
            className="h-6 w-14 rounded border border-line bg-surface-sunken px-1 text-sm tabular-nums text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <span aria-hidden>×</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Custom viewport height"
            placeholder="H"
            min={CUSTOM_LIMITS.min}
            max={CUSTOM_LIMITS.max}
            value={customViewport?.height ?? ''}
            onChange={(event) => {
              const height = Number(event.target.value);
              if (!event.target.value) return setCustomViewport(null);
              setCustomViewport({ width: customViewport?.width ?? (viewport.width || 390), height });
            }}
            className="h-6 w-14 rounded border border-line bg-surface-sunken px-1 text-sm tabular-nums text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>

        <div className="mx-1 h-4 w-px bg-line" />

        <IconButton
          label="Open the preview in a new tab"
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          disabled={!doc}
          onClick={openInTab}
        />
        <IconButton
          label="Show the console"
          icon={<TerminalSquare className="h-3.5 w-3.5" />}
          onClick={() => setBottomTab('output')}
        />

        <div className="ml-auto flex items-center gap-2 pr-1">
          {!viewport.responsive && (
            <span className="text-sm tabular-nums text-ink-faint">
              {/* The scale is shown because a shrunken frame otherwise looks
                  like a device with unusually small text. */}
              {scale === 1 ? viewport.label : `${viewport.label} · ${Math.round(scale * 100)}%`}
            </span>
          )}
          {status === 'building' && <Badge tone="accent">building</Badge>}
          {status === 'running' && (
            // Tabular figures so a rebuild that goes 98ms → 1204ms does not
            // resize the badge and shove the toolbar around.
            <Badge tone="positive">
              running · <span className="tabular-nums">{lastBuildMs}</span>ms
            </Badge>
          )}
          {status === 'error' && <Badge tone="danger">{errors.length} errors</Badge>}
        </div>
      </div>

      <div
        ref={stageRef}
        className={cx(
          'flex min-h-0 flex-1 items-center justify-center overflow-auto',
          viewport.responsive ? 'bg-white' : 'bg-canvas p-4',
        )}
      >
        {!previewSupported ? (
          <EmptyState
            icon={<Monitor className="h-4 w-4" />}
            title="Preview unavailable for this template"
            description={blueprint?.runnableNote}
          />
        ) : status === 'idle' ? (
          <EmptyState
            icon={<Play className="h-4 w-4" />}
            title="Preview is stopped"
            description="Run the project to bundle it with esbuild and render the result here."
          />
        ) : (
          <iframe
            ref={frameRef}
            key={buildToken}
            title="Project preview"
            srcDoc={doc}
            // No allow-same-origin: the preview stays in an opaque origin.
            sandbox={PREVIEW_SANDBOX}
            style={frameStyle}
            className={cx(
              'border-0 bg-white',
              !viewport.responsive && 'rounded-lg border border-line shadow-pop',
            )}
          />
        )}
      </div>

      {entry && status !== 'idle' && (
        <p className="shrink-0 border-t border-line px-2 py-1 font-mono text-sm text-ink-faint">
          entry: {entry}
        </p>
      )}
    </section>
  );
}
