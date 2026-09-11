import { useRef, useState } from 'react';
import { FileUp, FolderInput, HardDrive, X } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useLinuxFilesStore } from '@/stores/linuxFilesStore';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, UPLOAD_DIR } from '@/lib/linux/uploads';
import { formatBytes } from '@/lib/utils';

/**
 * Files a person puts into their Linux workspace, and the way into the project.
 *
 * The two workspaces are separate containers with separate directories, so
 * nothing uploaded here can appear in the project's source tree on its own.
 * "Use in project" is the only path across, it runs the gateway's explicit
 * transfer, and it reports the gateway's own answer — including the files that
 * were left alone because something already had that name.
 *
 * Uploads cross on the sync channel, which carries text. A binary would arrive
 * corrupted, so it is refused with what to do instead rather than accepted and
 * quietly ruined.
 */
export function LinuxFilesPanel() {
  const { uploads, busy, result, problem, upload, copyIntoProject, forget, clearResult } =
    useLinuxFilesStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reading, setReading] = useState(false);

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setReading(true);
    try {
      // Read as text on purpose: the channel carries strings, and a file that
      // does not survive that is refused by `planUploads` rather than sent.
      const candidates = await Promise.all(
        Array.from(list).map(async (file) => ({
          name: file.name,
          size: file.size,
          content: await file.text(),
        })),
      );
      upload(candidates);
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const chosen = uploads.filter((record) => selected.has(record.path));

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Linux files" />

      <div className="space-y-2 border-b border-line px-3 py-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => void onFiles(event.target.files)}
        />
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={reading}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp className="h-3.5 w-3.5" />
          <span>{reading ? 'Reading…' : 'Upload into the Linux workspace'}</span>
        </Button>
        <p className="text-2xs leading-relaxed text-ink-faint">
          <span>
            Files land in <code className="font-mono">{UPLOAD_DIR}/</code> inside the Linux
            workspace — a different machine from this project, with none of its source. Text only,
            up to {formatBytes(MAX_UPLOAD_BYTES)} each and {MAX_UPLOAD_FILES} at a time; for a
            binary or something larger, fetch it inside the workspace with curl or git.
          </span>
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!uploads.length ? (
          <EmptyState
            icon={<HardDrive className="h-4 w-4" />}
            title="No uploads yet"
            description="What you upload stays in the Linux workspace until you copy it into the project."
          />
        ) : (
          <ul className="divide-y divide-line">
            {uploads.map((record) => (
              <li key={record.path} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <input
                  type="checkbox"
                  className="tap-target"
                  checked={selected.has(record.path)}
                  onChange={() => toggle(record.path)}
                  aria-label={`Select ${record.path}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-ink">{record.path}</p>
                  <p className="tabular-nums text-2xs text-ink-faint">
                    {formatBytes(record.size)}
                  </p>
                </div>
                {record.usedIn && (
                  <Badge tone="positive" className="shrink-0">
                    in project
                  </Badge>
                )}
                <IconButton
                  label={`Forget ${record.path}`}
                  icon={<X className="h-3.5 w-3.5" />}
                  onClick={() => forget(record.path)}
                  size="sm"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2 border-t border-line px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={busy || !chosen.length}
          onClick={() => void copyIntoProject(chosen.map((record) => record.path))}
        >
          <FolderInput className="h-3.5 w-3.5" />
          <span>
            {busy
              ? 'Copying…'
              : `Use ${chosen.length || 'selected'} file${chosen.length === 1 ? '' : 's'} in project`}
          </span>
        </Button>
        <p className="text-2xs leading-relaxed text-ink-faint">
          <span>
            Copies into the project’s container at the same path, where the editor picks it up. An
            existing file is never overwritten — the copy is reported as a conflict instead. This
            needs both terminals open, since it is a copy between two running workspaces.
          </span>
        </p>
        {result && (
          <p className="text-2xs leading-relaxed text-positive">
            <span>{result}</span>
          </p>
        )}
        {problem && (
          <p className="text-2xs leading-relaxed text-danger">
            <span>{problem}</span>
          </p>
        )}
        {(result || problem) && (
          <button
            type="button"
            className="text-2xs text-accent hover:underline tap-target"
            onClick={clearResult}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
