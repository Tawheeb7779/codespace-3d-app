import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileArchive, Github, Upload } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { fetchGithubZip, importZip, parseRepoSpec, type ImportReport } from '@/lib/archive';
import { GithubRepoImport } from '@/components/github/GithubRepoImport';
import { useProjectStore } from '@/stores/projectStore';
import { toast } from '@/stores/toastStore';
import { cx, errorMessage, formatBytes } from '@/lib/utils';

type Source = 'zip' | 'github' | 'account';

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useProjectStore((s) => s.create);
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>('zip');
  const [repoSpec, setRepoSpec] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    setReport(null);
    setError(null);
    setBusy(false);
  };

  const ingest = async (data: ArrayBuffer | Blob, suggestedName: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await importZip(data);
      setReport(result);
      if (!name) setName(suggestedName);
    } catch (caught) {
      setError(errorMessage(caught));
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setError('Select a .zip archive.');
      return;
    }
    void ingest(file, file.name.replace(/\.zip$/i, ''));
  };

  const fromGithub = async () => {
    setBusy(true);
    setError(null);
    try {
      const { owner, repo, ref } = parseRepoSpec(repoSpec);
      const data = await fetchGithubZip(owner, repo, ref);
      await ingest(data, repo);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };

  const finish = async () => {
    if (!report) return;
    setBusy(true);
    try {
      const project = await create({
        name: name.trim() || 'Imported project',
        description: 'Imported project',
        template: 'blank',
        files: report.files,
        dirs: report.dirs,
      });
      toast.success('Project imported', `${Object.keys(report.files).length} files`);
      onClose();
      navigate(`/project/${project.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import a project"
      description="Bring in a ZIP archive or a public GitHub repository."
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {source !== 'account' && (
            <Button variant="primary" disabled={!report || busy} loading={busy} onClick={() => void finish()}>
              Create project
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div role="tablist" aria-label="Import source" className="flex gap-1 rounded border border-line p-1">
          {(
            [
              ['zip', 'ZIP archive', FileArchive],
              ['account', 'Your GitHub', Github],
              ['github', 'Public repo', Github],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              role="tab"
              type="button"
              aria-selected={source === value}
              onClick={() => {
                setSource(value);
                reset();
              }}
              className={cx(
                'flex flex-1 items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-base transition-colors',
                source === value ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {source === 'account' ? (
          <GithubRepoImport onDone={onClose} />
        ) : source === 'zip' ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              onFiles(event.dataTransfer.files);
            }}
            className={cx(
              'rounded-lg border border-dashed p-6 text-center transition-colors',
              dragging ? 'border-accent bg-accent-soft/30' : 'border-line',
            )}
          >
            <Upload aria-hidden className="mx-auto h-5 w-5 text-ink-faint" />
            <p className="mt-2 text-base text-ink">Drop a .zip here</p>
            <p className="mt-1 text-sm text-ink-faint">
              Text files only. Archives up to 40 MB and 3000 files.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="sr-only"
              onChange={(event) => onFiles(event.target.files)}
            />
            <Button size="sm" className="mt-3" onClick={() => fileInput.current?.click()}>
              Choose file
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              label="Repository"
              placeholder="vercel/next.js or a full GitHub URL"
              value={repoSpec}
              onChange={(event) => setRepoSpec(event.target.value)}
              hint="Public repositories only — Forge does not store GitHub tokens."
            />
            <Button size="sm" loading={busy} disabled={!repoSpec.trim()} onClick={() => void fromGithub()}>
              Fetch repository
            </Button>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
            {error}
          </p>
        )}

        {report && (
          <div className="space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
            <p className="text-base text-ink">
              {Object.keys(report.files).length} files ready ({formatBytes(report.totalBytes)})
            </p>
            {report.skipped.length > 0 && (
              <details className="text-sm text-ink-muted">
                <summary className="cursor-pointer text-caution">
                  {report.skipped.length} entries skipped
                </summary>
                <ul className="scrollbar-thin mt-2 max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs">
                  {report.skipped.slice(0, 100).map((entry) => (
                    <li key={entry.path} className="truncate">
                      {entry.path} — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <Input
              label="Project name"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
