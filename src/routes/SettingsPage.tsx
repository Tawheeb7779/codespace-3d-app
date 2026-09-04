import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Keyboard, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Select, Switch } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Primitives';
import { Modal } from '@/components/ui/Modal';
import {
  useSettingsStore,
  type ThemeName,
  type Density,
  type EsmCdn,
} from '@/stores/settingsStore';
import { useUIStore } from '@/stores/uiStore';
import { WIDE_CHANGE_THRESHOLD } from '@/lib/ai/approval';
import { GithubConnection } from '@/components/github/GithubConnection';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/stores/toastStore';
import { chordFromEvent, formatChord } from '@/hooks/useKeyboardShortcuts';
import { isSupabaseConfigured } from '@/lib/supabase';
import { persistenceStatus } from '@/lib/idb';
import { cx, errorMessage } from '@/lib/utils';

const SECTIONS = [
  'editor',
  'appearance',
  'terminal',
  'runtime',
  'sourceControl',
  'assistant',
  'workspace',
  'integrations',
  'keyboard',
  'account',
] as const;
type Section = (typeof SECTIONS)[number];

const LABELS: Record<Section, string> = {
  editor: 'Editor',
  appearance: 'Appearance',
  terminal: 'Terminal',
  runtime: 'Runtime',
  sourceControl: 'Source control',
  assistant: 'Assistant',
  workspace: 'Workspace',
  integrations: 'Integrations',
  keyboard: 'Keyboard',
  account: 'Account',
};

function Group({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line py-5 first:pt-0 last:border-0">
      <h2 className="text-md font-semibold text-ink">{title}</h2>
      {description && <p className="mt-1 text-base text-ink-muted">{description}</p>}
      <div className="mt-4 max-w-md space-y-3">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const {
    editor,
    appearance,
    runtime,
    terminal,
    git,
    agent,
    workspace,
    keybindings,
    setEditor,
    setAppearance,
    setRuntime,
    setTerminal,
    setGit,
    setAgent,
    setWorkspace,
    setKeybinding,
    resetKeybindings,
    resetAll,
  } = useSettingsStore();
  const resetLayout = useUIStore((s) => s.resetLayout);
  const { user, localMode, signOut } = useAuthStore();

  const [section, setSection] = useState<Section>('editor');
  const [recording, setRecording] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const persistence = persistenceStatus();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <Link to="/dashboard" className="flex items-center gap-1.5 text-ink-muted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="text-base">Dashboard</span>
        </Link>
        <h1 className="ml-2 text-base font-medium text-ink">Settings</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" className="w-44 shrink-0 border-r border-line p-2">
          {SECTIONS.map((item) => (
            <button
              key={item}
              type="button"
              aria-current={section === item}
              onClick={() => setSection(item)}
              className={cx(
                'block w-full rounded px-2.5 py-1.5 text-left text-base transition-colors',
                section === item
                  ? 'bg-surface-raised text-ink'
                  : 'text-ink-muted hover:bg-surface hover:text-ink',
              )}
            >
              {LABELS[item]}
            </button>
          ))}
        </nav>

        <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-5">
          {section === 'editor' && (
            <>
              <Group title="Typography" description="Applies to the code editor and terminal.">
                <Input
                  label="Font size"
                  type="number"
                  min={10}
                  max={24}
                  value={editor.fontSize}
                  onChange={(event) =>
                    setEditor({ fontSize: Number(event.target.value) || 13 })
                  }
                />
                <Input
                  label="Font family"
                  value={editor.fontFamily}
                  onChange={(event) => setEditor({ fontFamily: event.target.value })}
                  hint="Any CSS font stack. Monospace is strongly recommended."
                />
                <Select
                  label="Indent size"
                  value={String(editor.tabSize)}
                  onChange={(event) => setEditor({ tabSize: Number(event.target.value) })}
                  options={[
                    { value: '2', label: '2 spaces' },
                    { value: '4', label: '4 spaces' },
                    { value: '8', label: '8 spaces' },
                  ]}
                />
              </Group>

              <Group title="Behaviour">
                <Switch
                  label="Word wrap"
                  checked={editor.wordWrap}
                  onChange={(value) => setEditor({ wordWrap: value })}
                />
                <Switch
                  label="Minimap"
                  checked={editor.minimap}
                  onChange={(value) => setEditor({ minimap: value })}
                />
                <Switch
                  label="Line numbers"
                  checked={editor.lineNumbers}
                  onChange={(value) => setEditor({ lineNumbers: value })}
                />
                <Switch
                  label="Bracket pair colours"
                  checked={editor.bracketPairColorization}
                  onChange={(value) => setEditor({ bracketPairColorization: value })}
                />
                <Switch
                  label="Auto save"
                  description="Persist edits shortly after you stop typing."
                  checked={editor.autoSave}
                  onChange={(value) => setEditor({ autoSave: value })}
                />
                <Switch
                  label="Format on save"
                  description="Runs Monaco's formatter for languages that have one."
                  checked={editor.formatOnSave}
                  onChange={(value) => setEditor({ formatOnSave: value })}
                />
              </Group>
            </>
          )}

          {section === 'appearance' && (
            <>
              <Group title="Theme">
                <Select
                  label="Colour theme"
                  value={appearance.theme}
                  onChange={(event) =>
                    setAppearance({ theme: event.target.value as ThemeName })
                  }
                  options={[
                    { value: 'forge-dark', label: 'Forge Dark' },
                    { value: 'forge-light', label: 'Forge Light' },
                    { value: 'system', label: 'Match system' },
                  ]}
                />
                <Select
                  label="Interface density"
                  value={appearance.density}
                  onChange={(event) =>
                    setAppearance({ density: event.target.value as Density })
                  }
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                />
                <Switch
                  label="Reduce motion"
                  description="Disables panel and overlay animations. Your system preference is honoured automatically."
                  checked={appearance.reducedMotion}
                  onChange={(value) => setAppearance({ reducedMotion: value })}
                />
              </Group>

              <Group title="Layout">
                <p className="text-base text-ink-muted">
                  Panel sizes are remembered per browser. Reset them if the workspace ends up in an
                  awkward state.
                </p>
                <Button
                  size="sm"
                  leading={<RotateCcw className="h-3.5 w-3.5" />}
                  onClick={() => {
                    resetLayout();
                    toast.success('Layout reset');
                  }}
                >
                  Reset panel layout
                </Button>
              </Group>
            </>
          )}

          {section === 'terminal' && (
            <Group
              title="Terminal"
              description="The shell runs against this project's virtual file system. It never reaches the host machine."
            >
              <Input
                label="Font size"
                type="number"
                min={9}
                max={24}
                value={terminal.fontSize}
                onChange={(event) =>
                  setTerminal({ fontSize: Number(event.target.value) || 12 })
                }
              />
              <Input
                label="Scrollback lines"
                type="number"
                min={200}
                max={20000}
                step={100}
                value={terminal.scrollback}
                onChange={(event) =>
                  setTerminal({ scrollback: Number(event.target.value) || 3000 })
                }
                hint="Kept in memory per session. Older lines are dropped once the limit is reached."
              />
              <Switch
                label="Show the startup banner"
                description="Explains that commands operate on the virtual project, not your machine."
                checked={terminal.showBanner}
                onChange={(value) => setTerminal({ showBanner: value })}
              />
            </Group>
          )}

          {section === 'sourceControl' && (
            <Group title="Source control" description="Defaults for Forge VCS and pushes to GitHub.">
              <Input
                label="Default branch for new repositories"
                value={git.defaultBranch}
                onChange={(event) => setGit({ defaultBranch: event.target.value })}
                placeholder="main"
                hint="Used when you initialize a repository. Existing repositories keep their branch."
              />
              <Switch
                label="Stage everything when committing"
                description="Off means only files you have staged are committed, as git does by default."
                checked={git.stageAllOnCommit}
                onChange={(value) => setGit({ stageAllOnCommit: value })}
              />
            </Group>
          )}

          {section === 'assistant' && (
            <Group
              title="Assistant"
              description="How the coding agent behaves. Provider and API key are set in the assistant panel, and the key is never written to disk."
            >
              <Switch
                label="Check in on large changes"
                description={`Pause for approval once one task has changed ${WIDE_CHANGE_THRESHOLD} files. Deleting a file and running commands always ask, whatever this is set to.`}
                checked={agent.confirmWideChanges}
                onChange={(value) => setAgent({ confirmWideChanges: value })}
              />
              <Switch
                label="Verify edits with a real build"
                description="Ask the agent to compile the project after editing and report the result. Turning this off never lets it claim a build it did not run."
                checked={agent.verifyAfterEdits}
                onChange={(value) => setAgent({ verifyAfterEdits: value })}
              />
            </Group>
          )}

          {section === 'workspace' && (
            <Group title="Workspace" description="What happens when you open and leave a project.">
              <Switch
                label="Restore the last session"
                description="Reopen the files that were open, at the line you left them."
                checked={workspace.restoreSession}
                onChange={(value) => setWorkspace({ restoreSession: value })}
              />
              <Switch
                label="Confirm before deleting files"
                description="Off deletes immediately from the explorer. Committing first is how you get anything back."
                checked={workspace.confirmOnDelete}
                onChange={(value) => setWorkspace({ confirmOnDelete: value })}
              />
              <Switch
                label="Auto save"
                description="Write edits to storage shortly after you stop typing."
                checked={editor.autoSave}
                onChange={(value) => setEditor({ autoSave: value })}
              />
            </Group>
          )}

          {section === 'runtime' && (
            <Group
              title="Preview"
              description="How the in-browser bundler and preview behave."
            >
              <Switch
                label="Run on open"
                description="Build and start the preview when a project loads."
                checked={runtime.autoRun}
                onChange={(value) => setRuntime({ autoRun: value })}
              />
              <Switch
                label="Rebuild after edits"
                checked={runtime.reloadOnSave}
                onChange={(value) => setRuntime({ reloadOnSave: value })}
              />
              <Switch
                label="Clear preview logs on each run"
                checked={runtime.clearConsoleOnRun}
                onChange={(value) => setRuntime({ clearConsoleOnRun: value })}
              />
              <Select
                label="Package CDN for the preview"
                value={runtime.esmCdn}
                onChange={(event) => setRuntime({ esmCdn: event.target.value as EsmCdn })}
                options={[
                  { value: 'esm.sh', label: 'esm.sh' },
                  { value: 'jsdelivr', label: 'jsDelivr' },
                ]}
                hint="The preview has no node_modules, so bare imports are fetched from this CDN at the version package.json pins. Switch if your network blocks one."
              />
              <Input
                label="Local dev server port"
                type="number"
                min={1024}
                max={65535}
                value={runtime.devServerPort}
                onChange={(event) =>
                  setRuntime({ devServerPort: Number(event.target.value) || 5173 })
                }
                hint="Recorded for generated config files. The browser preview does not bind a port."
              />
            </Group>
          )}

          {section === 'integrations' && (

            <Group

              title="GitHub"

              description="Connect an account once; each project then points at a repository it can reach."

            >

              <GithubConnection />

            </Group>

          )}


          {section === 'keyboard' && (
            <Group
              title="Shortcuts"
              description="Click a shortcut, then press the combination you want."
            >
              <div className="overflow-hidden rounded-lg border border-line">
                {keybindings.map((binding) => (
                  <div
                    key={binding.id}
                    className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-0"
                  >
                    <span className="text-base text-ink">{binding.label}</span>
                    <button
                      type="button"
                      onClick={() => setRecording(binding.id)}
                      onKeyDown={(event) => {
                        if (recording !== binding.id) return;
                        event.preventDefault();
                        if (event.key === 'Escape') {
                          setRecording(null);
                          return;
                        }
                        if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
                        setKeybinding(binding.id, chordFromEvent(event.nativeEvent));
                        setRecording(null);
                      }}
                      onBlur={() => setRecording(null)}
                      className={cx(
                        'rounded border px-2 py-0.5 font-mono text-sm transition-colors',
                        recording === binding.id
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                      )}
                    >
                      {recording === binding.id ? 'Press keys…' : formatChord(binding.keys)}
                    </button>
                  </div>
                ))}
              </div>
              <Button
                size="sm"
                leading={<Keyboard className="h-3.5 w-3.5" />}
                onClick={() => {
                  resetKeybindings();
                  toast.success('Shortcuts reset to defaults');
                }}
              >
                Restore defaults
              </Button>
            </Group>
          )}

          {section === 'account' && (
            <>
              <Group title="Signed in as">
                <div className="flex items-center gap-3 rounded-lg border border-line p-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-base font-medium text-accent">
                    {user?.displayName?.slice(0, 1).toUpperCase() ?? '?'}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-base text-ink">{user?.displayName}</p>
                    <p className="truncate text-sm text-ink-faint">{user?.email}</p>
                  </div>
                  <Badge tone={localMode ? 'caution' : 'positive'} className="ml-auto">
                    {localMode ? 'Local' : user?.provider}
                  </Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void signOut()
                      .then(() => navigate('/'))
                      .catch((error) => toast.error('Sign out failed', errorMessage(error)));
                  }}
                >
                  Sign out
                </Button>
              </Group>

              <Group title="Storage">
                <dl className="space-y-2 text-base">
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Backend</dt>
                    <dd className="text-ink">
                      {localMode || !isSupabaseConfigured
                        ? 'IndexedDB (this browser)'
                        : 'Supabase Postgres'}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-muted">Local persistence</dt>
                    <dd className={persistence.ok ? 'text-positive' : 'text-danger'}>
                      {persistence.ok ? 'Working' : 'Unavailable'}
                    </dd>
                  </div>
                </dl>
                {!persistence.ok && (
                  <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
                    IndexedDB is not usable here ({persistence.reason}). Work is kept in memory for
                    this session only. Export anything you want to keep.
                  </p>
                )}
                {!isSupabaseConfigured && (
                  <p className="text-sm text-ink-faint">
                    Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to sync projects to Postgres
                    and enable sharing. See the README.
                  </p>
                )}
              </Group>

              <Group title="Reset">
                <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)}>
                  Reset all settings
                </Button>
              </Group>
            </>
          )}
        </div>
      </div>

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset all settings"
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                resetAll();
                resetLayout();
                setConfirmReset(false);
                toast.success('Settings restored to defaults');
              }}
            >
              Reset
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">
          Editor, appearance, runtime and keyboard settings return to their defaults. Your projects
          and files are not affected.
        </p>
      </Modal>
    </div>
  );
}
