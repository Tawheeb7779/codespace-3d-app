import { useEffect, useMemo, useRef } from 'react';
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
import { DEVICE_SIZES, usePreviewStore } from '@/stores/previewStore';
import { useFileStore } from '@/stores/fileStore';
import { useUIStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { consoleLog } from '@/stores/consoleStore';
import { toast } from '@/stores/toastStore';
import { getTemplate } from '@/lib/templates';
import type { ConsoleLevel, DevicepreSet } from '@/types';
import { cx } from '@/lib/utils';

const DEVICES: Array<{ id: DevicepreSet; label: string; icon: typeof Monitor }> = [
  { id: 'desktop', label: 'Responsive', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
];

/**
 * The live preview.
 *
 * The iframe is sandboxed to `allow-scripts` only: no same-origin access, so
 * project code cannot reach the IDE's storage or DOM. Console output arrives by
 * postMessage and is accepted only when it comes from this exact frame.
 */
export function PreviewPanel() {
  const { status, document: doc, entry, errors, device, lastBuildMs, buildToken, run, stop, refresh, setDevice } =
    usePreviewStore();
  const files = useFileStore((s) => s.files);
  const dirty = useFileStore((s) => s.dirty);
  const template = useFileStore((s) => s.meta?.template);
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

  const size = DEVICE_SIZES[device];
  const frameStyle = useMemo(
    () =>
      device === 'desktop'
        ? { width: '100%', height: '100%' }
        : { width: size.width, height: size.height, maxWidth: '100%', maxHeight: '100%' },
    [device, size],
  );

  const openInTab = () => {
    if (!doc) return;
    const blob = new Blob([doc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) toast.warning('Popup blocked', 'Allow popups for this site to open the preview.');
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
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

        {DEVICES.map((item) => (
          <IconButton
            key={item.id}
            label={item.label}
            active={device === item.id}
            icon={<item.icon className="h-3.5 w-3.5" />}
            onClick={() => setDevice(item.id)}
          />
        ))}

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
          {device !== 'desktop' && <span className="text-sm text-ink-faint">{size.label}</span>}
          {status === 'building' && <Badge tone="accent">building</Badge>}
          {status === 'running' && <Badge tone="positive">running · {lastBuildMs}ms</Badge>}
          {status === 'error' && <Badge tone="danger">{errors.length} errors</Badge>}
        </div>
      </div>

      <div
        className={cx(
          'flex min-h-0 flex-1 items-center justify-center overflow-auto',
          device === 'desktop' ? 'bg-white' : 'bg-canvas p-4',
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
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            style={frameStyle}
            className={cx(
              'border-0 bg-white',
              device !== 'desktop' && 'rounded-lg border border-line shadow-pop',
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
