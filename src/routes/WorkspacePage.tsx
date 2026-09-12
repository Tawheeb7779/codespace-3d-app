import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Bot, Files, FolderOpen, Monitor, SquareTerminal } from 'lucide-react';
import { disposeContainerTerminals } from '@/components/ide/ContainerTerminal';
import { ActivityBar } from '@/components/ide/ActivityBar';
import { WorkspaceTopBar } from '@/components/ide/WorkspaceTopBar';
import { FileExplorer } from '@/components/ide/FileExplorer';
import { ProjectPanel } from '@/components/ide/ProjectPanel';
import { ActivityPanel } from '@/components/ide/ActivityPanel';
import { TasksPanel } from '@/components/ide/TasksPanel';
import { Onboarding } from '@/components/ide/Onboarding';
import { SearchPanel } from '@/components/ide/SearchPanel';
import { GitPanel } from '@/components/ide/GitPanel';
import { PackagesPanel } from '@/components/ide/PackagesPanel';
import { AssistantPanel } from '@/components/ide/AssistantPanel';
import { MembersPanel } from '@/components/ide/MembersPanel';
import { CommentsPanel } from '@/components/ide/CommentsPanel';
import { SecurityPanel } from '@/components/ide/SecurityPanel';
import { ObservabilityPanel } from '@/components/ide/ObservabilityPanel';
import { HealthPanel } from '@/components/ide/HealthPanel';
import { ApiPanel } from '@/components/ide/ApiPanel';
import { EnvironmentPanel } from '@/components/ide/EnvironmentPanel';
import { PerformancePanel } from '@/components/ide/PerformancePanel';
import { ArchitecturePanel } from '@/components/ide/ArchitecturePanel';
import { TimeTravelPanel } from '@/components/ide/TimeTravelPanel';
import { ExtensionsPanel } from '@/components/ide/ExtensionsPanel';
import { BuilderPanel } from '@/components/ide/BuilderPanel';
import { DatabasePanel } from '@/components/ide/DatabasePanel';
import { UIBuilderPanel } from '@/components/ide/UIBuilderPanel';
import { LinuxFilesPanel } from '@/components/ide/LinuxFilesPanel';
import { EditorTabs } from '@/components/ide/EditorTabs';
import { Breadcrumbs } from '@/components/ide/Breadcrumbs';
import { CodeEditor } from '@/components/ide/CodeEditor';
import { EDITOR_COMMANDS, formatDocument, runEditorAction } from '@/lib/editorActions';
import { PreviewPanel } from '@/components/ide/PreviewPanel';
import { BottomPanel } from '@/components/ide/BottomPanel';
import { StatusBar } from '@/components/ide/StatusBar';
import { CommandPalette, type Command } from '@/components/ide/CommandPalette';
import { Resizer } from '@/components/ui/Resizer';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LAYOUTS, useUIStore, type SidebarPanel } from '@/stores/uiStore';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore, splitTargetFor } from '@/stores/editorStore';
import { useGitStore } from '@/stores/gitStore';
import type { RemoteResult } from '@/stores/gitStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useAuthStore } from '@/stores/authStore';
import { connectPresence, disconnectPresence } from '@/lib/collab/presenceTransport';
import { supabase } from '@/lib/supabase';
import { useTaskStore } from '@/stores/taskStore';
import { toast } from '@/stores/toastStore';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { isTextFile } from '@/lib/vfs';
import { allPanels, GROUP_LABEL } from '@/lib/workspacePanels';
import { canFormat } from '@/lib/languages';
import { buildProblems, mergeProblems, nextProblem } from '@/lib/problems';
import { cx, errorMessage } from '@/lib/utils';
import { ShortcutHelp } from '@/components/ide/ShortcutHelp';
import { NotificationCenter } from '@/components/ide/NotificationCenter';
import { useToastStore } from '@/stores/toastStore';

/**
 * Which component each panel is.
 *
 * A `Record` keyed by the union, not a switch with a default. The default was
 * quietly load-bearing: `explorer` had no case and reached the file tree only
 * by falling through it, so the drift a default exists to absorb had already
 * happened and nothing said so. Now a panel added to `SidebarPanel` fails the
 * build here and in `workspacePanels` until both know about it.
 */
const PANEL_COMPONENT: Record<SidebarPanel, () => JSX.Element> = {
  explorer: FileExplorer,
  project: ProjectPanel,
  activity: ActivityPanel,
  tasks: TasksPanel,
  search: SearchPanel,
  git: GitPanel,
  packages: PackagesPanel,
  assistant: AssistantPanel,
  comments: CommentsPanel,
  security: SecurityPanel,
  observability: ObservabilityPanel,
  health: HealthPanel,
  api: ApiPanel,
  environments: EnvironmentPanel,
  performance: PerformancePanel,
  architecture: ArchitecturePanel,
  timeline: TimeTravelPanel,
  extensions: ExtensionsPanel,
  builder: BuilderPanel,
  database: DatabasePanel,
  uibuilder: UIBuilderPanel,
  linuxfiles: LinuxFilesPanel,
  members: MembersPanel,
};

function SidePanel() {
  const panel = useUIStore((s) => s.sidebarPanel);
  const Panel = PANEL_COMPONENT[panel] ?? FileExplorer;
  return <Panel />;
}

function EditorArea({ path }: { path: string | null }) {
  const openTab = useEditorStore((s) => s.openTab);
  const splitPath = useEditorStore((s) => s.splitPath);
  const canWrite = useFileStore((s) => s.canWrite());
  const files = useFileStore((s) => s.files);
  const setQuickOpen = useUIStore((s) => s.setQuickOpenOpen);

  if (!path) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<FolderOpen className="h-4 w-4" />}
          title="No file open"
          description="Pick a file in the explorer, or press the quick-open shortcut."
          action={
            <Button size="sm" onClick={() => setQuickOpen(true)}>
              Open a file
            </Button>
          }
        />
      </div>
    );
  }

  if (!(path in files)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState title="This file no longer exists" description={path} />
      </div>
    );
  }

  if (!isTextFile(path)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          title="Cannot open this file type in the editor"
          description={`${path} is not a recognised text format. Rename it or download it instead.`}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1">
        <CodeEditor path={path} readOnly={!canWrite} />
      </div>
      {splitPath && splitPath in files && (
        <>
          <div className="w-px shrink-0 bg-line" />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => openTab(splitPath)}
              className="w-full truncate border-b border-line px-3 py-1 text-left text-sm text-ink-faint hover:text-ink"
            >
              {splitPath}
            </button>
            <div className="h-[calc(100%-1.75rem)]">
              <CodeEditor path={splitPath} readOnly={!canWrite} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const MOBILE_PANES = [
  { id: 'files', label: 'Files', icon: Files },
  { id: 'editor', label: 'Editor', icon: FolderOpen },
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'assistant', label: 'AI', icon: Bot },
] as const;

export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const {
    sidebarOpen,
    sidebarWidth,
    previewOpen,
    previewWidth,
    bottomOpen,
    bottomHeight,
    mobilePane,
    commandPaletteOpen,
    quickOpenOpen,
    setSidebarWidth,
    setPreviewWidth,
    setBottomHeight,
    toggleSidebar,
    togglePreview,
    toggleBottom,
    setSidebarPanel,
    setBottomTab,
    setCommandPaletteOpen,
    setQuickOpenOpen,
    setMobilePane,
    layout,
    applyLayout,
    toggleFocus,
  } = useUIStore();

  const { open, close, loading, error, meta, files, flush, canWrite } = useFileStore();
  const { activePath, openTab, closeTab, closeOthers, closeAll, closeSaved, tabs, cursor, setSplit } =
    useEditorStore();
  const dirty = useFileStore((s) => s.dirty);
  // Reactive slices so the palette re-derives when the repository changes.
  const gitInitialized = useGitStore((s) => s.repo.initialized);
  const gitBranches = useGitStore((s) => s.repo.branches);
  const gitHead = useGitStore((s) => s.repo.head);
  const hasRemote = useGitStore((s) => Boolean(s.remote));
  const requestCreate = useUIStore((s) => s.requestCreate);
  const taskConfigs = useTaskStore((s) => s.configs);
  const taskBusy = useTaskStore((s) => s.activeRunId !== null);
  const requestReplace = useUIStore((s) => s.requestReplace);
  const loadGit = useGitStore((s) => s.load);
  const gitInit = useGitStore((s) => s.init);
  const previewRun = usePreviewStore((s) => s.run);
  const previewStop = usePreviewStore((s) => s.stop);
  const previewRefresh = usePreviewStore((s) => s.refresh);
  const previewStatus = usePreviewStore((s) => s.status);
  const runtime = useSettingsStore((s) => s.runtime);
  const setAppearance = useSettingsStore((s) => s.setAppearance);
  const editorSettings = useSettingsStore((s) => s.editor);
  const setEditor = useSettingsStore((s) => s.setEditor);
  const appearance = useSettingsStore((s) => s.appearance);
  const [ready, setReady] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // Load the project, then its version history.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setReady(false);
    open(projectId)
      .then(async () => {
        if (cancelled) return;
        await loadGit(projectId);
        setReady(true);
      })
      .catch(() => setReady(true));
    return () => {
      cancelled = true;
      // The container terminals belong to the project being left, and so does
      // the sync engine feeding them. Without this they outlive the switch:
      // `disposeContainerTerminals` existed and was called from nowhere, so a
      // terminal on the previous project stayed attached while the editor moved
      // on. The engine is guarded against acting across that boundary anyway;
      // this is the other half — not leaving a shell and a WebSocket running
      // for a project the user has closed.
      disposeContainerTerminals(projectId);
    };
  }, [projectId, open, loadGit]);

  /**
   * Announce this tab, and hear about everyone else's.
   *
   * `enter` is what puts this person in the presence store at all; the
   * transport is what makes the store's `remote` list mean something. Both are
   * torn down on leaving, because a channel left open for a project the user
   * has closed keeps publishing them into a room they are no longer in.
   *
   * With no Supabase the transport declines and the store keeps reporting
   * `local-only` — the panel then says it knows only this tab, which is true.
   */
  useEffect(() => {
    const user = useAuthStore.getState().user;
    if (!projectId || !user) return;
    usePresenceStore.getState().enter(projectId, user);
    connectPresence(supabase, projectId);
    return () => {
      disconnectPresence();
      usePresenceStore.getState().leave();
    };
  }, [projectId]);

  // Where this person is working, for the others. Only the path: presence
  // carries no file content, and must not.
  useEffect(() => {
    usePresenceStore.getState().touch(activePath ?? null);
  }, [activePath]);

  /**
   * Put back the last session, or open a sensible first file.
   *
   * Keyed on the project so "Close all" (or closing the last tab) actually
   * leaves an empty editor instead of being undone on the next render.
   */
  const greeted = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !projectId || greeted.current === projectId) return;
    if (activePath || !Object.keys(files).length) return;
    greeted.current = projectId;
    // Both histories are about *this* project, and this line runs once per
    // project. Restoring a session seeds them again immediately below; without
    // the reset, quick open would offer paths from whichever project was open
    // before, and Ctrl+Shift+T would reopen a file from it.
    useEditorStore.setState({ recent: [], closed: [] });

    if (
      useSettingsStore.getState().workspace.restoreSession &&
      useEditorStore.getState().restoreSession(projectId, (path) => path in files)
    ) {
      return;
    }

    const preferred =
      ['src/App.tsx', 'src/App.jsx', 'src/main.tsx', 'src/main.ts', 'index.html', 'README.md'].find(
        (candidate) => candidate in files,
      ) ?? Object.keys(files).filter(isTextFile).sort()[0];
    if (preferred) openTab(preferred);
  }, [ready, projectId, activePath, files, openTab]);

  // Start the preview automatically when the project supports it.
  useEffect(() => {
    if (!ready || !runtime.autoRun || previewStatus !== 'idle') return;
    if (!Object.keys(files).length) return;
    void previewRun();
    // Only the initial load should auto-run; later runs are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /**
   * Keep the stored session current.
   *
   * Written on change rather than only on unmount, because a tab that is
   * closed by a crash or a hard reload never gets an unmount.
   */
  useEffect(() => {
    if (!ready || !projectId) return;
    useEditorStore.getState().rememberSession(projectId);
  }, [ready, projectId, tabs, activePath, cursor]);

  useEffect(() => () => void close(), [close]);

  /**
   * Show the terminal, or hide the panel if it is already showing.
   *
   * `setBottomTab` opens the panel as a side effect, so calling it before an
   * unconditional `toggleBottom()` always landed on closed — the shortcut and
   * the command could hide the panel but never bring it back.
   */
  /**
   * Move to the next or previous diagnostic.
   *
   * Reads the same merged list the Problems panel shows, so the keyboard and
   * the panel can never disagree about what "next" means.
   */
  const goToProblem = useCallback((direction: 1 | -1) => {
    const editor = useEditorStore.getState();
    const preview = usePreviewStore.getState();
    const all = mergeProblems([
      buildProblems(preview.errors),
      buildProblems(preview.warnings),
      editor.problems,
    ]);
    const target = nextProblem(
      all,
      editor.activePath
        ? {
            path: editor.activePath,
            line: editor.cursor.line,
            column: editor.cursor.column,
          }
        : null,
      direction,
    );
    if (target) editor.revealLocation(target.path, target.line, target.column);
    else toast.info('No problems reported');
  }, []);

  /** Run a remote operation and report exactly what GitHub answered. */
  const runRemote = useCallback(async (action: () => Promise<RemoteResult>) => {
    try {
      const result = await action();
      if (result.ok) toast.success(result.message, result.detail);
      else toast.error(result.message, result.detail);
    } catch (caught) {
      toast.error('GitHub request failed', errorMessage(caught));
    }
  }, []);

  /** Move focus one tab along, wrapping — the usual editor behaviour. */
  /**
   * Put back the last closed file.
   *
   * Closing a tab has never discarded anything here — the file lives in the
   * store, the tab is only a view of it — so reopening is safe. What is not
   * safe is reopening onto a path that has since been deleted or renamed, which
   * would leave a tab over nothing; that case says so instead.
   */
  const reopenClosedTab = useCallback(() => {
    const path = useEditorStore.getState().reopenClosed();
    if (!path) {
      toast.info('Nothing to reopen', 'No editor has been closed in this session.');
      return;
    }
    if (!(path in useFileStore.getState().files)) {
      toast.info('That file is gone', `${path} no longer exists in this project.`);
      return;
    }
    openTab(path);
  }, [openTab]);

  const cycleTab = useCallback(
    (delta: number) => {
      const open = useEditorStore.getState().tabs;
      if (open.length < 2) return;
      const index = open.findIndex((tab) => tab.path === useEditorStore.getState().activePath);
      const next = open[(index + delta + open.length) % open.length];
      if (next) useEditorStore.getState().setActive(next.path);
    },
    [],
  );

  const toggleTerminalPanel = useCallback(() => {
    const next = !useUIStore.getState().bottomOpen;
    if (next) setBottomTab('terminal');
    else toggleBottom(false);
  }, [setBottomTab, toggleBottom]);

  const save = useCallback(async () => {
    try {
      if (useSettingsStore.getState().editor.formatOnSave && activePath && canFormat(activePath)) {
        await formatDocument();
      }
      await flush();
    } catch {
      // The store reports it: every save path fails the same way, and auto-save
      // failing silently was the whole problem.
    }
  }, [flush, activePath]);

  /** Run a git action, reporting the real outcome rather than assuming one. */
  const gitAction = useCallback(
    (label: string, action: () => Promise<unknown>, done?: (result: unknown) => void) => () => {
      void action()
        .then((result) => (done ? done(result) : toast.success(label)))
        .catch((caught) => toast.error(`${label} failed`, errorMessage(caught)));
    },
    [],
  );

  const commands: Command[] = useMemo(() => {

    const base: Command[] = [
      {
        id: 'file.new',
        group: 'File',
        label: 'New file',
        disabled: !canWrite(),
        run: () => requestCreate('file'),
      },
      {
        id: 'file.newFolder',
        group: 'File',
        label: 'New folder',
        disabled: !canWrite(),
        run: () => requestCreate('folder'),
      },
      {
        id: 'file.quickOpen',
        group: 'File',
        label: 'Quick open file',
        binding: 'quickOpen',
        run: () => setQuickOpenOpen(true),
      },
      { id: 'file.save', group: 'File', label: 'Save all files', binding: 'save', run: () => void save() },
      {
        id: 'file.reopen',
        group: 'File',
        label: 'Reopen closed editor',
        binding: 'reopenTab',
        run: reopenClosedTab,
      },
      {
        id: 'file.close',
        group: 'File',
        label: 'Close editor tab',
        binding: 'closeTab',
        disabled: !activePath,
        run: () => activePath && closeTab(activePath),
      },
      {
        id: 'file.closeOthers',
        group: 'File',
        label: 'Close other editor tabs',
        disabled: tabs.length < 2 || !activePath,
        run: () => activePath && closeOthers(activePath),
      },
      {
        id: 'file.closeSaved',
        group: 'File',
        label: 'Close saved editor tabs',
        disabled: tabs.every((tab) => dirty.has(tab.path) || tab.pinned),
        run: () => closeSaved((path) => dirty.has(path)),
      },
      {
        id: 'file.closeAll',
        group: 'File',
        label: 'Close all editor tabs',
        disabled: !tabs.length,
        run: closeAll,
      },
      {
        id: 'help.notifications',
        group: 'Help',
        label: 'Show notifications',
        run: () => {
          useToastStore.getState().markRead();
          setNotificationsOpen(true);
        },
      },
      {
        id: 'help.shortcuts',
        group: 'Help',
        label: 'Keyboard shortcuts',
        binding: 'shortcutHelp',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'view.focus',
        group: 'View',
        label: layout === 'focus' ? 'Leave focus mode' : 'Enter focus mode',
        binding: 'focusMode',
        run: () => toggleFocus(),
      },
      ...LAYOUTS.filter((preset) => preset.id !== 'focus').map((preset) => ({
        id: `view.layout.${preset.id}`,
        group: 'View',
        label: `Layout: ${preset.label}`,
        disabled: layout === preset.id,
        run: () => applyLayout(preset.id),
      })),
      {
        id: 'view.zoomIn',
        group: 'View',
        label: 'Increase editor font size',
        disabled: editorSettings.fontSize >= 24,
        run: () => setEditor({ fontSize: Math.min(24, editorSettings.fontSize + 1) }),
      },
      {
        id: 'view.zoomOut',
        group: 'View',
        label: 'Decrease editor font size',
        disabled: editorSettings.fontSize <= 10,
        run: () => setEditor({ fontSize: Math.max(10, editorSettings.fontSize - 1) }),
      },
      {
        id: 'view.zoomReset',
        group: 'View',
        label: 'Reset editor font size',
        disabled: editorSettings.fontSize === 13,
        run: () => setEditor({ fontSize: 13 }),
      },
      {
        id: 'edit.format',
        group: 'Edit',
        label: 'Format document',
        binding: 'format',
        disabled: !activePath || !canFormat(activePath ?? ''),
        run: () => {
          void formatDocument().then((done) => {
            if (!done) toast.info('No formatter for this language');
          });
        },
      },
      {
        id: 'edit.replace',
        group: 'Edit',
        label: 'Replace in files',
        run: requestReplace,
      },
      {
        id: 'problems.next',
        group: 'Go',
        label: 'Go to next problem',
        keys: 'f8',
        run: () => goToProblem(1),
      },
      {
        id: 'problems.previous',
        group: 'Go',
        label: 'Go to previous problem',
        keys: 'shift+f8',
        run: () => goToProblem(-1),
      },
      {
        id: 'view.terminal',
        group: 'View',
        label: 'Toggle terminal',
        binding: 'toggleTerminal',
        run: toggleTerminalPanel,
      },
      {
        id: 'view.problems',
        group: 'View',
        label: 'Show problems',
        run: () => setBottomTab('problems'),
      },
      {
        id: 'view.output',
        group: 'View',
        label: 'Show output',
        run: () => setBottomTab('output'),
      },
      {
        id: 'view.preview',
        group: 'View',
        label: 'Toggle preview',
        binding: 'togglePreview',
        run: () => togglePreview(),
      },
      {
        id: 'view.sidebar',
        group: 'View',
        label: 'Toggle sidebar',
        binding: 'toggleSidebar',
        run: () => toggleSidebar(),
      },
      {
        id: 'run.start',
        group: 'Run',
        label: 'Build and run the project',
        binding: 'run',
        run: () => void previewRun(),
      },
      { id: 'run.stop', group: 'Run', label: 'Stop preview', run: previewStop },
      {
        id: 'run.restart',
        group: 'Run',
        label: 'Restart the preview',
        run: () => void previewRefresh(),
      },
      {
        id: 'git.status',
        group: 'Source control',
        label: 'Show source control',
        binding: 'sourceControl',
        run: () => setSidebarPanel('git'),
      },
      {
        id: 'git.init',
        group: 'Source control',
        label: 'Initialize repository',
        disabled: !canWrite() || gitInitialized,
        run: () => {
          void gitInit()
            .then(() => toast.success('Repository initialized'))
            .catch((caught) => toast.error('Could not initialize', errorMessage(caught)));
        },
      },
      {
        id: 'git.stage',
        group: 'Source control',
        label: 'Stage all changes',
        disabled: !canWrite() || !gitInitialized,
        run: gitAction('Staged all changes', () => useGitStore.getState().stage()),
      },
      {
        id: 'git.commit',
        group: 'Source control',
        label: 'Commit staged changes…',
        disabled: !canWrite() || !gitInitialized,
        // Committing needs a message, which lives in the source control panel.
        run: () => setSidebarPanel('git'),
      },
      {
        id: 'git.fetch',
        group: 'Source control',
        label: 'Fetch from GitHub',
        disabled: !hasRemote,
        run: () => void runRemote(() => useGitStore.getState().fetchRemote()),
      },
      {
        id: 'git.pull',
        group: 'Source control',
        label: 'Pull from GitHub',
        disabled: !hasRemote || !canWrite(),
        run: () => void runRemote(() => useGitStore.getState().pullRemote()),
      },
      {
        id: 'git.push',
        group: 'Source control',
        label: 'Push to GitHub',
        disabled: !hasRemote || !canWrite(),
        run: () => void runRemote(() => useGitStore.getState().pushRemote()),
      },
      {
        id: 'theme.toggle',
        group: 'Preferences',
        label: `Switch to ${appearance.theme === 'forge-light' ? 'dark' : 'light'} theme`,
        run: () =>
          setAppearance({
            theme: appearance.theme === 'forge-light' ? 'forge-dark' : 'forge-light',
          }),
      },
      {
        id: 'settings.open',
        group: 'Preferences',
        label: 'Open settings',
        run: () => navigate('/settings'),
      },
      {
        id: 'terminal.new',
        group: 'Terminal',
        label: 'New terminal session',
        run: () => {
          useTerminalStore.getState().createSession();
          setBottomTab('terminal');
        },
      },
      {
        id: 'nav.dashboard',
        group: 'Go',
        label: 'Back to dashboard',
        run: () => navigate('/dashboard'),
      },
    ];

    // Monaco's own actions, surfaced by name. Each reports honestly when the
    // language cannot support it rather than appearing to do nothing.
    const editorCommands: Command[] = EDITOR_COMMANDS.map((entry) => ({
      id: entry.id,
      group: 'Code',
      label: entry.label,
      disabled: !activePath,
      run: () => {
        void runEditorAction(entry.action).then((ran) => {
          if (ran) return;
          toast.info(
            `${entry.label} is not available here`,
            entry.needsLanguageService
              ? 'This needs a language service, which runs for JavaScript and TypeScript.'
              : 'The editor did not accept that action for this file.',
          );
        });
      },
    }));

    // Every saved run configuration is a command, so a task is reachable from
    // the keyboard without opening its panel.
    const taskCommands: Command[] = taskConfigs.map((config) => ({
      id: `task.run.${config.id}`,
      group: 'Tasks',
      label: `Run task: ${config.name}`,
      disabled: taskBusy,
      run: () => {
        void useTaskStore
          .getState()
          .start(config.id)
          .catch((error) => toast.error('Could not start the task', errorMessage(error)));
      },
    }));

    // One entry per branch beats a picker nobody can find: switching is a
    // real checkout through the same store the panel uses.
    const branchCommands: Command[] = Object.keys(gitBranches)
      .filter((branch) => branch !== gitHead)
      .sort()
      .map((branch) => ({
        id: `git.checkout.${branch}`,
        group: 'Source control',
        label: `Switch to branch ${branch}`,
        disabled: !canWrite(),
        run: gitAction(`Switched to ${branch}`, () => useGitStore.getState().checkout(branch)),
      }));

    /*
     * Every panel, from the one registry that describes them.
     *
     * Seven of the twenty-three used to be written out here by hand, which
     * meant the other sixteen existed only as an icon in the rail: the
     * database studio, the API client, the profiler and the security centre
     * could not be reached by typing their names. Deriving them means a panel
     * cannot be added without also being findable, and the group shown beside
     * each one is the same hierarchy the rail presents.
     */
    const panelCommands: Command[] = allPanels().map(({ id, info }) => ({
      id: `view.panel.${id}`,
      group: GROUP_LABEL[info.group],
      // The keywords are searchable but not shown: somebody looking for the
      // profiler types "profiler", and the panel is called Performance.
      label: `Show ${info.label}`,
      keywords: info.keywords,
      binding: info.binding,
      run: () => setSidebarPanel(id),
    }));

    return [...base, ...panelCommands, ...editorCommands, ...taskCommands, ...branchCommands];
  }, [
    activePath,
    reopenClosedTab,
    appearance.theme,
    canWrite,
    closeAll,
    closeOthers,
    closeSaved,
    closeTab,
    dirty,
    editorSettings.fontSize,
    gitAction,
    goToProblem,
    gitBranches,
    gitHead,
    gitInit,
    gitInitialized,
    hasRemote,
    navigate,
    previewRefresh,
    previewRun,
    previewStop,
    requestCreate,
    requestReplace,
    runRemote,
    save,
    applyLayout,
    layout,
    setAppearance,
    setBottomTab,
    setEditor,
    setQuickOpenOpen,
    setSidebarPanel,
    tabs,
    taskBusy,
    taskConfigs,
    toggleFocus,
    togglePreview,
    toggleSidebar,
    toggleTerminalPanel,
  ]);

  useKeyboardShortcuts(
    useMemo(
      () => ({
        commandPalette: () => setCommandPaletteOpen(true),
        quickOpen: () => setQuickOpenOpen(true),
        save: () => void save(),
        toggleTerminal: toggleTerminalPanel,
        toggleSidebar: () => toggleSidebar(),
        togglePreview: () => togglePreview(),
        search: () => setSidebarPanel('search'),
        closeTab: () => activePath && closeTab(activePath),
        reopenTab: reopenClosedTab,
        run: () => void previewRun(),
        format: () => void formatDocument(),
        nextTab: () => cycleTab(1),
        previousTab: () => cycleTab(-1),
        splitEditor: () => setSplit(splitTargetFor(tabs, activePath)),
        sourceControl: () => setSidebarPanel('git'),
        explorer: () => setSidebarPanel('explorer'),
        assistant: () => setSidebarPanel('assistant'),
        focusMode: () => toggleFocus(),
        shortcutHelp: () => setShortcutsOpen(true),
      }),
      [
        activePath,
        reopenClosedTab,
        closeTab,
        cycleTab,
        previewRun,
        save,
        setCommandPaletteOpen,
        setQuickOpenOpen,
        setSidebarPanel,
        setSplit,
        tabs,
        togglePreview,
        toggleSidebar,
        toggleFocus,
        toggleTerminalPanel,
      ],
    ),
  );

  // Warn before losing unsaved work.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (useFileStore.getState().dirty.size) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (loading && !meta) {
    return (
      <div className="ta-ground flex h-full flex-col items-center justify-center gap-3">
        <Spinner className="h-5 w-5" />
        <p className="text-sm text-ink-faint">Opening project…</p>
      </div>
    );
  }

  if (error && !meta) {
    return (
      <div className="ta-ground flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md">
          <ErrorState title="Could not open this project" detail={error} />
          <Button className="mt-3" onClick={() => navigate('/dashboard')}>
            Back to dashboard
          </Button>
        </div>
      </div>
    );
  }

  const palette = (
    <CommandPalette
      open={commandPaletteOpen || quickOpenOpen}
      fileMode={quickOpenOpen}
      onClose={() => {
        setCommandPaletteOpen(false);
        setQuickOpenOpen(false);
      }}
      commands={commands}
      files={Object.keys(files)}
      onOpenFile={(path) => {
        openTab(path);
        setMobilePane('editor');
      }}
    />
  );

  if (isMobile) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-canvas">
        <WorkspaceTopBar
        onCommandPalette={() => setCommandPaletteOpen(true)}
        onNotifications={() => setNotificationsOpen(true)}
      />
        <main className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary area="Workspace">
            {mobilePane === 'files' && <SidePanel />}
            {mobilePane === 'editor' && (
              <div className="flex h-full flex-col">
                <EditorTabs />
                {activePath && <Breadcrumbs path={activePath} />}
                <EditorArea path={activePath} />
              </div>
            )}
            {mobilePane === 'preview' && <PreviewPanel />}
            {mobilePane === 'terminal' && <BottomPanel />}
            {mobilePane === 'assistant' && <AssistantPanel />}
          </ErrorBoundary>
        </main>
        <nav
          aria-label="Workspace sections"
          className="flex shrink-0 items-stretch border-t border-line bg-surface"
        >
          {MOBILE_PANES.map((pane) => (
            <button
              key={pane.id}
              type="button"
              aria-current={mobilePane === pane.id}
              onClick={() => {
                if (pane.id === 'files') setSidebarPanel('explorer');
                setMobilePane(pane.id);
              }}
              className={cx(
                'flex flex-1 flex-col items-center gap-0.5 py-2 text-2xs transition-colors',
                mobilePane === pane.id ? 'text-accent' : 'text-ink-faint',
              )}
            >
              <pane.icon className="h-4 w-4" />
              {pane.label}
            </button>
          ))}
        </nav>
        <StatusBar />
        {palette}
      <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <NotificationCenter open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <WorkspaceTopBar
        onCommandPalette={() => setCommandPaletteOpen(true)}
        onNotifications={() => setNotificationsOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <ActivityBar />

        {sidebarOpen && (
          <>
            <aside
              style={{ width: sidebarWidth }}
              className="flex shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
            >
              <ErrorBoundary area="Sidebar">
                <SidePanel />
              </ErrorBoundary>
            </aside>
            <Resizer
              orientation="vertical"
              label="Resize sidebar"
              onResize={(delta) => setSidebarWidth(sidebarWidth + delta)}
              onDoubleClick={() => toggleSidebar(false)}
            />
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <section aria-label="Editor" className="ta-ground flex min-w-0 flex-1 flex-col">
              <EditorTabs />
              {activePath && <Breadcrumbs path={activePath} />}
              <ErrorBoundary area="Editor">
                <EditorArea path={tabs.length ? activePath : null} />
              </ErrorBoundary>
            </section>

            {previewOpen && (
              <>
                <Resizer
                  orientation="vertical"
                  label="Resize preview"
                  onResize={(delta) => setPreviewWidth(previewWidth - delta)}
                  onDoubleClick={() => togglePreview(false)}
                />
                <div style={{ width: previewWidth }} className="shrink-0 overflow-hidden">
                  <ErrorBoundary area="Preview">
                    <PreviewPanel />
                  </ErrorBoundary>
                </div>
              </>
            )}
          </div>

          {bottomOpen && (
            <>
              <Resizer
                orientation="horizontal"
                label="Resize panel"
                onResize={(delta) => setBottomHeight(bottomHeight - delta)}
                onDoubleClick={() => toggleBottom(false)}
              />
              <div style={{ height: bottomHeight }} className="shrink-0 overflow-hidden">
                <ErrorBoundary area="Panel">
                  <BottomPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>

      <StatusBar />
      {palette}
      <ShortcutHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <NotificationCenter open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
      <Onboarding />
    </div>
  );
}
