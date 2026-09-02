import { AlertCircle, AlertTriangle, Check, CloudOff, GitBranch, Loader2 } from 'lucide-react';
import { useEditorStore } from '@/stores/editorStore';
import { useFileStore } from '@/stores/fileStore';
import { useGitStore } from '@/stores/gitStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';
import { getLanguage } from '@/lib/languages';
import { cx, formatTimeAgo } from '@/lib/utils';

function Item({
  children,
  onClick,
  label,
  tone,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  label?: string;
  tone?: 'danger' | 'caution' | 'accent';
}) {
  const className = cx(
    'flex h-full items-center gap-1 px-2 text-sm transition-colors',
    tone === 'danger' && 'text-danger',
    tone === 'caution' && 'text-caution',
    tone === 'accent' && 'text-accent',
    !tone && 'text-ink-muted',
    onClick && 'hover:bg-surface-raised hover:text-ink',
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={label} className={className}>
      {children}
    </button>
  ) : (
    <span className={className}>{children}</span>
  );
}

export function StatusBar() {
  const activePath = useEditorStore((s) => s.activePath);
  const cursor = useEditorStore((s) => s.cursor);
  const problems = useEditorStore((s) => s.problems);
  const { dirty, saving, lastSavedAt, role } = useFileStore();
  const repo = useGitStore((s) => s.repo);
  const status = useGitStore((s) => s.status);
  const previewStatus = usePreviewStore((s) => s.status);
  const editorSettings = useSettingsStore((s) => s.editor);
  const setEditor = useSettingsStore((s) => s.setEditor);
  const setBottomTab = useUIStore((s) => s.setBottomTab);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);
  const localMode = useAuthStore((s) => s.localMode);

  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;

  return (
    <footer className="flex h-6 shrink-0 items-stretch justify-between border-t border-line bg-surface text-sm">
      <div className="flex items-stretch">
        {repo.initialized && (
          <Item onClick={() => setSidebarPanel('git')} label="Open source control">
            <GitBranch className="h-3 w-3" />
            {repo.head}
            {!status.clean && (
              <span className="text-caution">
                {status.staged.length + status.unstaged.length}
              </span>
            )}
          </Item>
        )}
        <Item
          onClick={() => setBottomTab('problems')}
          label="Open the problems panel"
          tone={errors ? 'danger' : warnings ? 'caution' : undefined}
        >
          <AlertCircle className="h-3 w-3" />
          {errors}
          <AlertTriangle className="ml-1 h-3 w-3" />
          {warnings}
        </Item>
        {previewStatus !== 'idle' && (
          <Item tone={previewStatus === 'error' ? 'danger' : 'accent'}>
            {previewStatus === 'building' ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> building
              </>
            ) : previewStatus === 'error' ? (
              'build failed'
            ) : (
              'preview running'
            )}
          </Item>
        )}
      </div>

      <div className="flex items-stretch">
        {localMode && (
          <Item label="Local development mode">
            <CloudOff className="h-3 w-3" /> Local
          </Item>
        )}
        {role !== 'owner' && role !== 'editor' && <Item tone="caution">read-only</Item>}
        <Item>
          {saving ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> saving
            </>
          ) : dirty.size ? (
            `${dirty.size} unsaved`
          ) : lastSavedAt ? (
            <>
              <Check className="h-3 w-3 text-positive" /> saved {formatTimeAgo(lastSavedAt)}
            </>
          ) : (
            'no changes'
          )}
        </Item>
        {activePath && (
          <>
            <Item>
              Ln {cursor.line}, Col {cursor.column}
            </Item>
            <Item
              onClick={() =>
                setEditor({ tabSize: editorSettings.tabSize === 2 ? 4 : 2 })
              }
              label="Toggle indent size"
            >
              Spaces: {editorSettings.tabSize}
            </Item>
            <Item>{getLanguage(activePath).label}</Item>
          </>
        )}
      </div>
    </footer>
  );
}
