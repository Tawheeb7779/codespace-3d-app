import { useMemo } from 'react';
import {
  Clock,
  ExternalLink,
  FileCode2,
  GitBranch,
  Github,
  Package,
  Settings,
} from 'lucide-react';
import { PanelHeader, Badge, EmptyState } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ide/FileIcon';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useGitStore } from '@/stores/gitStore';
import { useUIStore } from '@/stores/uiStore';
import { formatBytes, formatTimeAgo } from '@/lib/utils';
import { basename, dirname } from '@/lib/vfs';

/**
 * What this project is, and where it stands right now.
 *
 * Deliberately one dense column rather than a grid of cards: everything here
 * is read from the stores that already own it — the file map, the repository,
 * the remote — so the panel cannot drift from what the rest of the IDE shows.
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-2.5 py-1">
      <span className="w-20 shrink-0 text-sm text-ink-faint">{label}</span>
      <span className="min-w-0 flex-1 text-base text-ink">{children}</span>
    </div>
  );
}

export function ProjectPanel() {
  const meta = useFileStore((s) => s.meta);
  const files = useFileStore((s) => s.files);
  const dirty = useFileStore((s) => s.dirty);
  const lastSavedAt = useFileStore((s) => s.lastSavedAt);
  const saving = useFileStore((s) => s.saving);

  const repo = useGitStore((s) => s.repo);
  const status = useGitStore((s) => s.status);
  const history = useGitStore((s) => s.history);
  const remote = useGitStore((s) => s.remote);

  const tabs = useEditorStore((s) => s.tabs);
  const openTab = useEditorStore((s) => s.openTab);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);
  const setQuickOpen = useUIStore((s) => s.setQuickOpenOpen);

  const size = useMemo(
    () => Object.values(files).reduce((total, content) => total + content.length, 0),
    [files],
  );
  const fileCount = Object.keys(files).length;
  const recent = tabs.slice(-6).reverse();
  const changed = status.staged.length + status.unstaged.length;

  if (!meta) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Project" />
        <EmptyState title="No project open" description="Open a project to see its details." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Project" />

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="border-b border-line py-1.5">
          <div className="px-2.5 pb-1">
            <h2 className="truncate text-md font-medium text-ink">{meta.name}</h2>
            {meta.description && (
              <p className="mt-0.5 text-sm text-ink-muted">{meta.description}</p>
            )}
          </div>
          <Row label="Language">
            <Badge>{meta.language}</Badge>
          </Row>
          <Row label="Visibility">{meta.visibility}</Row>
          <Row label="Files">
            {fileCount} file{fileCount === 1 ? '' : 's'} · {formatBytes(size)}
          </Row>
          <Row label="Saved">
            <span className="flex items-center gap-1.5">
              <Clock aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
              {saving
                ? 'Saving…'
                : dirty.size
                  ? `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}`
                  : lastSavedAt
                    ? formatTimeAgo(lastSavedAt)
                    : 'Not saved yet'}
            </span>
          </Row>
        </div>

        {/* Source control */}
        <div className="border-b border-line py-1.5">
          <p className="panel-label px-2.5 py-0.5">Source control</p>
          {repo.initialized ? (
            <>
              <Row label="Branch">
                <span className="flex items-center gap-1.5">
                  <GitBranch aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
                  <span className="truncate font-mono">{repo.head}</span>
                </span>
              </Row>
              <Row label="Status">
                {changed
                  ? `${changed} change${changed === 1 ? '' : 's'}`
                  : 'Clean since the last commit'}
              </Row>
              <Row label="Commits">{history.length}</Row>
              {history[0] && (
                <Row label="Latest">
                  <span className="truncate">
                    {history[0].message}{' '}
                    <span className="text-ink-faint">{formatTimeAgo(history[0].timestamp)}</span>
                  </span>
                </Row>
              )}
            </>
          ) : (
            <p className="px-2.5 py-1 text-base text-ink-muted">No repository yet.</p>
          )}
          <div className="px-2.5 pt-1">
            <Button size="xs" onClick={() => setSidebarPanel('git')}>
              Open source control
            </Button>
          </div>
        </div>

        {/* Remote */}
        <div className="border-b border-line py-1.5">
          <p className="panel-label px-2.5 py-0.5">Repository</p>
          {remote ? (
            <>
              <Row label="GitHub">
                <a
                  href={`https://github.com/${remote.owner}/${remote.repo}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 truncate text-accent hover:underline"
                >
                  <Github aria-hidden className="h-3 w-3 shrink-0" />
                  <span className="truncate font-mono">
                    {remote.owner}/{remote.repo}
                  </span>
                  <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
                </a>
              </Row>
              <Row label="Tracking">
                <span className="truncate font-mono">{remote.branch}</span>
              </Row>
            </>
          ) : (
            <p className="px-2.5 py-1 text-base text-ink-muted">
              Not connected to a GitHub repository.
            </p>
          )}
        </div>

        {/* Recent files */}
        <div className="border-b border-line py-1.5">
          <p className="panel-label px-2.5 py-0.5">Recent files</p>
          {recent.length ? (
            recent.map((tab) => (
              <button
                key={tab.path}
                type="button"
                onClick={() => openTab(tab.path)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-surface-raised"
              >
                <FileIcon path={tab.path} />
                <span className="min-w-0 truncate text-base text-ink">{basename(tab.path)}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-faint">
                  {dirname(tab.path)}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2.5 py-1 text-base text-ink-muted">Nothing open yet.</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5 p-2.5">
          <Button size="xs" leading={<FileCode2 className="h-3 w-3" />} onClick={() => setQuickOpen(true)}>
            Quick open
          </Button>
          <Button size="xs" leading={<Package className="h-3 w-3" />} onClick={() => setSidebarPanel('packages')}>
            Packages
          </Button>
          <Button size="xs" leading={<Settings className="h-3 w-3" />} onClick={() => setSidebarPanel('search')}>
            Search project
          </Button>
        </div>
      </div>
    </div>
  );
}
