import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Command,
  Download,
  Hammer,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Play,
  Save,
  Settings,
  Square,
} from 'lucide-react';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Primitives';
import { useUIStore } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { toast } from '@/stores/toastStore';
import { downloadBlob, exportZip, safeArchiveName } from '@/lib/archive';
import { getTemplate } from '@/lib/templates';
import { errorMessage } from '@/lib/utils';
import { formatChord } from '@/hooks/useKeyboardShortcuts';

export function WorkspaceTopBar({ onCommandPalette }: { onCommandPalette: () => void }) {
  const { sidebarOpen, previewOpen, bottomOpen, toggleSidebar, togglePreview, toggleBottom } =
    useUIStore();
  const { meta, files, dirs, dirty, flush, saving } = useFileStore();
  const previewStatus = usePreviewStore((s) => s.status);
  const run = usePreviewStore((s) => s.run);
  const stop = usePreviewStore((s) => s.stop);
  const keybindings = useSettingsStore((s) => s.keybindings);
  const [exporting, setExporting] = useState(false);

  const chord = (id: string) => keybindings.find((b) => b.id === id)?.keys ?? '';
  const runnable = meta ? getTemplate(meta.template).runnable : true;

  const exportProject = async () => {
    if (!meta) return;
    setExporting(true);
    try {
      const blob = await exportZip(meta.name, files, dirs);
      downloadBlob(blob, `${safeArchiveName(meta.name)}.zip`);
      toast.success('Exported', `${Object.keys(files).length} files`);
    } catch (error) {
      toast.error('Export failed', errorMessage(error));
    } finally {
      setExporting(false);
    }
  };

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
      <Link to="/dashboard" aria-label="Back to dashboard" className="flex items-center gap-1.5 pr-1">
        <ArrowLeft className="h-3.5 w-3.5 text-ink-faint" />
        <span className="flex h-5 w-5 items-center justify-center rounded bg-accent text-accent-ink">
          <Hammer className="h-3 w-3" />
        </span>
      </Link>

      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-base font-medium text-ink">{meta?.name ?? 'Loading…'}</h1>
        {meta && <Badge>{meta.language}</Badge>}
        {dirty.size > 0 && <span className="text-sm text-ink-faint">•</span>}
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          leading={<Command className="h-3.5 w-3.5" />}
          onClick={onCommandPalette}
          className="hidden sm:inline-flex"
        >
          <span className="text-ink-faint">{formatChord(chord('commandPalette'))}</span>
        </Button>

        <IconButton
          label="Save all files"
          icon={<Save className="h-3.5 w-3.5" />}
          disabled={!dirty.size || saving}
          onClick={() => void flush().catch((error) => toast.error('Save failed', errorMessage(error)))}
        />
        <IconButton
          label="Export project as ZIP"
          icon={<Download className="h-3.5 w-3.5" />}
          disabled={exporting || !meta}
          onClick={() => void exportProject()}
        />

        <div className="mx-1 h-4 w-px bg-line" />

        {previewStatus === 'idle' ? (
          <Button
            size="sm"
            variant="primary"
            leading={<Play className="h-3.5 w-3.5" />}
            disabled={!runnable}
            onClick={() => void run()}
          >
            Run
          </Button>
        ) : (
          <Button size="sm" leading={<Square className="h-3.5 w-3.5" />} onClick={stop}>
            Stop
          </Button>
        )}

        <div className="mx-1 h-4 w-px bg-line" />

        <IconButton
          label="Toggle sidebar"
          active={sidebarOpen}
          icon={<PanelLeft className="h-3.5 w-3.5" />}
          onClick={() => toggleSidebar()}
        />
        <IconButton
          label="Toggle bottom panel"
          active={bottomOpen}
          icon={<PanelBottom className="h-3.5 w-3.5" />}
          onClick={() => toggleBottom()}
        />
        <IconButton
          label="Toggle preview"
          active={previewOpen}
          icon={<PanelRight className="h-3.5 w-3.5" />}
          onClick={() => togglePreview()}
        />
        <Link to="/settings">
          <IconButton label="Settings" icon={<Settings className="h-3.5 w-3.5" />} />
        </Link>
      </div>
    </header>
  );
}
