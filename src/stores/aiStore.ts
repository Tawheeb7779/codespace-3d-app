import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_PROVIDER,
  ProviderError,
  readApiKey,
  writeApiKey,
  type ChatMessage,
  type ProviderConfig,
  type ProviderErrorKind,
} from '@/lib/ai/provider';
import { runAgent, type AgentActivity } from '@/lib/ai/agent';
import type { ToolContext } from '@/lib/ai/tools';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { execute, type ShellSession } from '@/lib/shell';
import { createShellHost } from '@/lib/shellHost';
import { useGitStore } from '@/stores/gitStore';
import { useProjectStore } from '@/stores/projectStore';
import { usePreviewStore } from '@/stores/previewStore';
import { buildPreview } from '@/lib/preview';
import { unifiedDiff } from '@/lib/diff';
import { headContent as vcsHeadContent } from '@/lib/vcs';
import { isSensitivePath, readableFiles } from '@/lib/vfs';
import { useAgentStore, projectContextHeader, readCache } from '@/stores/agentStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { recordActivity } from '@/stores/activityStore';
import { WIDE_CHANGE_THRESHOLD } from '@/lib/ai/approval';
import {
  buildContextSections,
  DEFAULT_CONTEXT,
  renderContextSections,
  type ContextChoices,
  type ContextSection,
  type ContextSource,
} from '@/lib/ai/contextControl';
import { workflowById, type WorkflowId } from '@/lib/ai/workflows';
import { errorMessage, uid } from '@/lib/utils';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  activities: AgentActivity[];
  timestamp: number;
}

interface AiState {
  provider: ProviderConfig;
  apiKeyPresent: boolean;
  /**
   * Session-scoped approval for irreversible tool calls: deleting a file, or
   * running a destructive shell command. Deliberately not persisted, so it
   * resets to off every time the app loads.
   */
  allowDestructive: boolean;
  messages: AssistantMessage[];
  transcript: ChatMessage[];
  running: boolean;
  error: string | null;
  /**
   * What kind of failure the last error was, when the provider said.
   *
   * A rate limit is not a bad key and neither is an outage; the panel can only
   * tell the user what to do next if it knows which one happened.
   */
  errorKind: ProviderErrorKind | null;
  retryAt: number | null;
  /** The prompt of the last turn, so a failed task can be retried as sent. */
  lastPrompt: string | null;
  /**
   * What the user chose to send. These narrow what leaves the browser; they
   * can never widen it, because protected paths are filtered before this is
   * consulted.
   */
  context: ContextChoices;
  /** Text selected in the editor, mirrored here for workflows to quote. */
  selection: string;

  setProvider: (patch: Partial<ProviderConfig>) => void;
  setApiKey: (key: string) => void;
  setAllowDestructive: (allowed: boolean) => void;
  send: (prompt: string) => Promise<void>;
  /** Run a named workflow through the same agent loop as a typed request. */
  runWorkflow: (id: WorkflowId) => Promise<void>;
  setContextSource: (source: ContextSource, enabled: boolean) => void;
  setSelection: (selection: string) => void;
  retry: () => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

let controller: AbortController | null = null;

/** Ceiling on the diff handed to a model, so one turn cannot carry a project. */
const MAX_DIFF_CHARS = 40_000;

/**
 * Build the tool context bound to the currently open project.
 *
 * The context is rebuilt for every turn so the agent always sees the current
 * file map — it is a live view of the workspace, not a snapshot taken when the
 * conversation started.
 */
function toolContext(): ToolContext {
  const fileStore = useFileStore.getState();
  const agent = useAgentStore.getState();
  return {
    files: fileStore.files,
    dirs: fileStore.dirs,
    canWrite: fileStore.canWrite(),
    allowDestructive: useAiStore.getState().allowDestructive,
    writeFile(path, content) {
      const store = useFileStore.getState();
      if (path in store.files) store.writeFile(path, content);
      else store.createFile(path, content);
      useEditorStore.getState().openTab(path);
    },
    deletePath(path) {
      useFileStore.getState().remove(path);
      useEditorStore.getState().removePath(path);
    },
    async runShell(command) {
      const terminal = useTerminalStore.getState();
      const id = terminal.activeId ?? terminal.createSession();
      const session: ShellSession = { cwd: '', history: [] };
      terminal.append(id, [{ kind: 'command', text: `agent$ ${command}` }]);
      useAgentStore.getState().noteCommand(command);
      const result = await execute(command, session, createShellHost());
      terminal.append(id, result.lines);
      return result.lines.map((line) => line.text).join('\n') || '(no output)';
    },
    terminalOutput: () => useTerminalStore.getState().recentOutput(),

    requestApproval: (action, affects) =>
      useAgentStore.getState().requestApproval(action, affects, 'run_command'),

    /**
     * A real compile through the same bundler the preview uses, so a passing
     * verification means the project actually builds.
     */
    async runBuild() {
      const result = await buildPreview(useFileStore.getState().files);
      const ok = result.errors.length === 0;
      recordActivity('build.completed', ok ? 'succeeded' : `${result.errors.length} error(s)`);
      const report = ok
        ? `Build succeeded: ${result.entry} in ${result.durationMs}ms.`
        : [
            `Build failed with ${result.errors.length} error(s):`,
            ...result.errors
              .slice(0, 20)
              .map((error) => `  ${error.path}:${error.line}:${error.column} ${error.message}`),
          ].join('\n');
      useAgentStore.getState().noteVerification({
        name: 'build',
        ok,
        ran: true,
        detail: report.split('\n')[0],
      });
      // Keep the preview panel honest about the build the agent just ran.
      if (usePreviewStore.getState().status !== 'idle') void usePreviewStore.getState().run();
      return { ok, report };
    },

    diagnostics() {
      const problems = useEditorStore.getState().problems;
      if (!problems.length) return 'No problems reported.';
      const lines = problems
        .slice(0, 40)
        .map((p) => `${p.path}:${p.line}:${p.column} ${p.severity}: ${p.message}`);
      useAgentStore.getState().noteVerification({
        name: 'diagnostics',
        ok: !problems.some((p) => p.severity === 'error'),
        ran: true,
        detail: `${problems.length} problem(s) reported`,
      });
      return lines.join('\n');
    },

    /**
     * The project's uncommitted changes, as a real unified diff.
     *
     * Built from the repository's HEAD tree against the working files — the
     * same comparison the source control panel shows — and filtered through
     * the protected-path policy, so a review can never be handed a secret.
     */
    gitDiff() {
      const git = useGitStore.getState();
      if (!git.repo.initialized) return '';
      const files = readableFiles(useFileStore.getState().files);
      const changed = [...git.status.staged, ...git.status.unstaged];
      const seen = new Set<string>();
      const parts: string[] = [];
      for (const change of changed) {
        if (seen.has(change.path)) continue;
        seen.add(change.path);
        if (isSensitivePath(change.path)) continue;
        const before = vcsHeadContent(git.repo, change.path);
        const after = files[change.path] ?? '';
        const patch = unifiedDiff(change.path, before, after);
        if (patch) parts.push(patch);
        if (parts.join('\n').length > MAX_DIFF_CHARS) {
          parts.push('… (diff truncated)');
          break;
        }
      }
      return parts.join('\n\n');
    },

    onChange: (path, kind, before, after) => agent.noteChange(path, kind, before, after),
    onRead: (path, content) => readCache.record(path, content),

    changedSoFar: () => useAgentStore.getState().task?.changes.length ?? 0,
    wideChangeThreshold: useSettingsStore.getState().agent.confirmWideChanges
      ? WIDE_CHANGE_THRESHOLD
      : null,
  };
}

/** What the current turn would send, given the user's context choices. */
export function currentContextSections(): ContextSection[] {
  const fileStore = useFileStore.getState();
  const editor = useEditorStore.getState();
  const git = useGitStore.getState();
  return buildContextSections(useAiStore.getState().context, {
    currentPath: editor.activePath,
    selection: useAiStore.getState().selection,
    openPaths: editor.tabs.map((tab) => tab.path),
    files: fileStore.files,
    diagnostics: editor.problems.map(
      (problem) => `${problem.path}:${problem.line} ${problem.severity}: ${problem.message}`,
    ),
    changedPaths: [...git.status.staged, ...git.status.unstaged].map((change) => change.path),
    terminalOutput: useTerminalStore.getState().recentOutput(),
  });
}

/** The compact, targeted header the agent is given about the workspace. */
function contextMessage(): string {
  const fileStore = useFileStore.getState();
  const meta = fileStore.meta;
  const git = useGitStore.getState();
  const problems = useEditorStore.getState().problems;
  const header = projectContextHeader({
    name: meta?.name ?? useProjectStore.getState().projects[0]?.name ?? 'Untitled project',
    template: meta?.template ?? 'blank',
    language: meta?.language ?? 'Plain Text',
    branch: git.repo.initialized ? git.repo.head : '(no repository)',
    files: fileStore.files,
    dirty: [...fileStore.dirty],
    diagnostics: problems
      .slice(0, 10)
      .map((p) => `${p.path}:${p.line} ${p.severity}: ${p.message}`),
  });
  const chosen = renderContextSections(currentContextSections());
  return chosen ? `${header}\n\n${chosen}` : header;
}

export const useAiStore = create<AiState>()(
  persist(
    (set, get) => ({
      provider: DEFAULT_PROVIDER,
      apiKeyPresent: typeof window !== 'undefined' && Boolean(readApiKey()),
      allowDestructive: false,
      messages: [],
      transcript: [],
      running: false,
      error: null,
      errorKind: null,
      retryAt: null,
      lastPrompt: null,
      context: DEFAULT_CONTEXT,
      selection: '',

      setProvider: (patch) => set((state) => ({ provider: { ...state.provider, ...patch } })),

      setApiKey: (key) => {
        writeApiKey(key.trim());
        set({ apiKeyPresent: Boolean(key.trim()) });
      },

      setAllowDestructive: (allowed) => set({ allowDestructive: allowed }),

      setContextSource: (source, enabled) =>
        set((state) => ({ context: { ...state.context, [source]: enabled } })),

      setSelection: (selection) => set({ selection }),

      /**
       * A workflow is a prepared prompt, nothing more: it goes through `send`,
       * so it obeys the same tools, approvals, cancellation and verification
       * as anything typed by hand.
       */
      async runWorkflow(id) {
        const workflow = workflowById(id);
        if (!workflow) return;
        const editor = useEditorStore.getState();
        const git = useGitStore.getState();
        const scope = {
          path: editor.activePath,
          selection: get().selection,
          hasDiagnostics: editor.problems.length > 0,
          hasChanges: !git.status.clean,
        };
        const blocked = workflow.unavailable(scope);
        if (blocked) {
          set({ error: blocked, errorKind: null });
          return;
        }
        await get().send(workflow.prompt(scope));
      },

      async send(prompt) {
        const text = prompt.trim();
        if (!text || get().running) return;

        // One task per project at a time. Two agents editing the same virtual
        // file system would interleave writes into a state neither planned.
        const projectId = useFileStore.getState().projectId ?? 'local';
        const task = useAgentStore.getState().begin(text, projectId);
        if (!task) {
          set({ error: 'An agent task is already running on this project.' });
          return;
        }

        const userMessage: AssistantMessage = {
          id: uid('msg'),
          role: 'user',
          text,
          activities: [],
          timestamp: Date.now(),
        };
        const assistantId = uid('msg');
        set((state) => ({
          messages: [
            ...state.messages,
            userMessage,
            {
              id: assistantId,
              role: 'assistant',
              text: '',
              activities: [],
              timestamp: Date.now(),
            },
          ],
          running: true,
          error: null,
          errorKind: null,
          retryAt: null,
          lastPrompt: text,
        }));
        recordActivity('agent.started', text);

        const patch = (updater: (message: AssistantMessage) => AssistantMessage) =>
          set((state) => ({
            messages: state.messages.map((m) => (m.id === assistantId ? updater(m) : m)),
          }));

        controller = new AbortController();
        // The header goes in once per task, not on every turn: the model keeps
        // earlier messages in context, so resending it would be pure cost.
        const priorTurns = get().transcript.length;
        const content = priorTurns === 0 ? `${contextMessage()}\n\n---\n\n${text}` : text;
        const transcript: ChatMessage[] = [...get().transcript, { role: 'user', content }];

        try {
          const agent = useAgentStore.getState();
          const result = await runAgent(
            get().provider,
            readApiKey(),
            transcript,
            toolContext(),
            {
              onActivity: (activity) => {
                agent.setPhase('inspecting');
                patch((message) => {
                  const activities = message.activities.some((a) => a.id === activity.id)
                    ? message.activities.map((a) => (a.id === activity.id ? activity : a))
                    : [...message.activities, activity];
                  return { ...message, activities };
                });
              },
              onText: (chunk) => patch((message) => ({ ...message, text: chunk })),
              onToolStart: (tool) => useAgentStore.getState().noteActivityPhase(tool),
              onPlan: (plan) => useAgentStore.getState().setPlan(plan),
              verifyAfterEdits: useSettingsStore.getState().agent.verifyAfterEdits,
            },
            controller.signal,
          );
          set({ transcript: result.transcript, running: false });
          await useFileStore.getState().flush();
          const finished = useAgentStore.getState().task;
          useAgentStore.getState().finish('completed');
          recordActivity(
            'agent.completed',
            `${finished?.changes.length ?? 0} file(s) changed`,
          );
        } catch (error) {
          const cancelled = error instanceof DOMException && error.name === 'AbortError';
          const message = cancelled ? 'Cancelled.' : errorMessage(error);
          patch((existing) => ({
            ...existing,
            role: existing.text ? existing.role : 'error',
            text: existing.text || message,
          }));
          set({
            running: false,
            error: message,
            errorKind: error instanceof ProviderError ? error.kind : null,
            retryAt: error instanceof ProviderError ? error.retryAt : null,
          });
          // Whatever the agent had already written is real and stays on disk;
          // the task record says what got done before it stopped.
          await useFileStore.getState().flush().catch(() => undefined);
          useAgentStore.getState().finish(cancelled ? 'cancelled' : 'failed', cancelled ? undefined : message);
        } finally {
          controller = null;
        }
      },

      /**
       * Send the last prompt again.
       *
       * The transcript is left as it was: a retry after a rate limit or a
       * dropped connection should reach the model with the same history, not a
       * conversation that now contains a failure the model has to reason about.
       */
      async retry() {
        const prompt = get().lastPrompt;
        if (!prompt || get().running) return;
        set((state) => ({
          // Drop the failed exchange so the retry is not read as a second ask.
          messages: state.messages.slice(0, -2),
          error: null,
          errorKind: null,
          retryAt: null,
        }));
        await get().send(prompt);
      },

      cancel() {
        // Abort first so no further model or tool call starts, then settle the
        // task — which also releases any approval the agent is blocked on.
        controller?.abort();
        set({ running: false });
        useAgentStore.getState().finish('cancelled');
      },

      reset: () => {
        readCache.clear();
        set({
          messages: [],
          transcript: [],
          error: null,
          errorKind: null,
          retryAt: null,
          lastPrompt: null,
        });
      },
    }),
    {
      name: 'forge.ai',
      // The API key is deliberately excluded: it lives in sessionStorage only.
      partialize: (state) => ({ provider: state.provider, context: state.context }),
    },
  ),
);
