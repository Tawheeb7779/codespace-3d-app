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

/**
 * One reading in the status bar.
 *
 * `whitespace-nowrap` and `shrink-0` are the load-bearing classes. Without
 * them a narrow viewport shrinks each item below its text width, the text
 * wraps to a second line, and — because the bar is a fixed 24px — that line
 * paints outside it, over the bottom navigation.
 *
 * `minor` items are the ones a phone-width bar can do without: they are laid
 * out normally from `sm` up and simply absent below it, which keeps the
 * remaining readings on one line rather than squeezing all of them.
 */
function Item({
  children,
  onClick,
  label,
  tone,
  minor,
  shrinkable,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  label?: string;
  tone?: 'danger' | 'caution' | 'accent';
  minor?: boolean;
  /** Give way first when the bar runs out of room. Only the branch name does. */
  shrinkable?: boolean;
}) {
  const className = cx(
    'h-full items-center gap-1 whitespace-nowrap px-2 text-sm transition-colors',
    /*
     * The bar is shorter than a finger.
     *
     * These take their height from the status bar, which is 23px on a phone —
     * measured in Chromium at 390x844, and under the 24x24 CSS px minimum for
     * a pointer target. `tap-target` is the project's answer to exactly this:
     * it grows the *hit* area to 32px under a coarse pointer through a
     * transparent pseudo-element, leaves the painted bar the size it is, and
     * costs desktop nothing because the rule only exists under
     * `(pointer: coarse)`.
     *
     * Only on the clickable variant. A span is not a target and giving it one
     * would put an invisible 32px box over its neighbours.
     */
    onClick && 'tap-target',
    shrinkable ? 'min-w-0 shrink' : 'shrink-0',
    minor ? 'hidden sm:flex' : 'flex',
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
  const { dirty, saving, lastSavedAt, role, error: saveError } = useFileStore();
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

  /**
   * The save reading, as an icon that may be absent and a label that never is.
   *
   * A failed save comes first. It used to read as "1 unsaved", which is what an
   * edit you have not saved yet also reads as, so a cloud deployment refusing
   * every write looked exactly like normal typing — right up to the reload that
   * threw the work away.
   */
  const save: { icon: React.ReactNode; label: string; at: number | null; tone?: 'danger' } =
    saving
      ? { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: 'saving', at: null }
      : saveError && dirty.size
        ? {
            icon: <AlertCircle className="h-3 w-3" />,
            label: `${dirty.size} not saved`,
            at: null,
            tone: 'danger',
          }
        : dirty.size
          ? { icon: null, label: `${dirty.size} unsaved`, at: null }
          : lastSavedAt
            ? { icon: <Check className="h-3 w-3 text-positive" />, label: 'saved', at: lastSavedAt }
            : { icon: null, label: 'no changes', at: null };

  return (
    // `overflow-hidden` is the backstop: whatever the readings add up to, the
    // bar is one 24px line and nothing escapes it onto the row below.
    <footer className="flex h-6 shrink-0 items-stretch justify-between overflow-hidden border-t border-line bg-surface text-sm">
      {/* The left group is the one allowed to give way — a long branch name
          ellipsises rather than pushing the right-hand readings off screen. */}
      <div className="flex min-w-0 items-stretch">
        {repo.initialized && (
          <Item onClick={() => setSidebarPanel('git')} label="Open source control" shrinkable>
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="truncate">{repo.head}</span>
            {!status.clean && (
              <span className="shrink-0 text-caution">
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
            {/* The spinner comes and goes; the label does not. Keeping the text
                inside an element that survives every transition means React
                only ever inserts or removes next to an element it still owns —
                a bare text node here is one an extension can replace, and then
                the removal throws. */}
            {previewStatus === 'building' && <Loader2 className="h-3 w-3 animate-spin" />}
            <span>
              {previewStatus === 'building'
                ? 'building'
                : previewStatus === 'error'
                  ? 'build failed'
                  : 'preview running'}
            </span>
          </Item>
        )}
      </div>

      <div className="flex shrink-0 items-stretch">
        {localMode && (
          <Item label="Local development mode">
            <CloudOff className="h-3 w-3" /> Local
          </Item>
        )}
        {role !== 'owner' && role !== 'editor' && <Item tone="caution">read-only</Item>}
        {/* Same shape as the preview reading: the icon is the part that
            changes, the label stays in an element of its own. */}
        <Item
          tone={save.tone}
          onClick={save.tone ? () => setBottomTab('output') : undefined}
          label={save.tone ? 'Saving failed — open the output panel' : undefined}
        >
          {save.icon}
          <span>{save.label}</span>
          {/* The relative time is what pushed this reading past the width a
              phone can give it. */}
          {save.at !== null && (
            <span className="hidden sm:inline">{formatTimeAgo(save.at)}</span>
          )}
        </Item>
        {activePath && (
          <>
            {/* Tabular figures: this updates on every keystroke, and with
                proportional digits the whole right-hand end of the bar shifts
                sideways as you move between column 9 and column 10. */}
            <Item minor>
              <span className="tabular-nums">
                Ln {cursor.line}, Col {cursor.column}
              </span>
            </Item>
            <Item
              onClick={() =>
                setEditor({ tabSize: editorSettings.tabSize === 2 ? 4 : 2 })
              }
              label="Toggle indent size"
              minor
            >
              Spaces: {editorSettings.tabSize}
            </Item>
            <Item minor>{getLanguage(activePath).label}</Item>
          </>
        )}
      </div>
    </footer>
  );
}
