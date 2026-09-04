import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Plug, RotateCcw, Send, Square, Trash2, User } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, Select, Switch } from '@/components/ui/Field';
import { currentContextSections, useAiStore } from '@/stores/aiStore';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useGitStore } from '@/stores/gitStore';
import { Tooltip } from '@/components/ui/Tooltip';
import { WORKFLOWS, type WorkflowScope } from '@/lib/ai/workflows';
import {
  CONTEXT_DESCRIPTIONS,
  CONTEXT_LABELS,
  contextSize,
  type ContextSource,
} from '@/lib/ai/contextControl';
import { AgentTaskBar } from '@/components/ide/AgentTaskBar';
import { readApiKey, type ProviderErrorKind, type ProviderKind } from '@/lib/ai/provider';
import type { AgentActivity } from '@/lib/ai/agent';
import { cx } from '@/lib/utils';

/**
 * What to do about each kind of provider failure.
 *
 * A bad key, a rate limit and an outage all read as "it did not work" without
 * this; only one of them is worth pressing retry on straight away.
 */
const ERROR_ADVICE: Record<ProviderErrorKind, string> = {
  'not-configured': 'Connect a provider to start.',
  unauthorized: 'The provider rejected the key. Check it in provider settings.',
  'rate-limited': 'The provider is rate limiting this key.',
  server: 'The provider is having trouble. Retrying usually works.',
  timeout: 'The provider did not answer in time. Try again.',
  network: 'Could not reach the provider. Check the base URL and your network.',
  malformed: 'The provider sent a response Forge could not read.',
  request: 'The provider refused the request.',
};

function retryHint(retryAt: number | null): string {
  if (!retryAt) return '';
  const seconds = retryAt - Math.floor(Date.now() / 1000);
  return seconds > 0 ? ` Wait about ${seconds}s before retrying.` : '';
}

const STATE_MARK: Record<AgentActivity['state'], { glyph: string; tone: string }> = {
  pending: { glyph: '○', tone: 'text-ink-faint' },
  running: { glyph: '◐', tone: 'text-accent' },
  done: { glyph: '✓', tone: 'text-positive' },
  error: { glyph: '✕', tone: 'text-danger' },
};

function ActivityList({ activities }: { activities: AgentActivity[] }) {
  if (!activities.length) return null;
  return (
    <ul className="mt-2 space-y-0.5 rounded border border-line bg-surface-sunken p-2 font-mono text-sm">
      {activities.map((activity) => {
        const mark = STATE_MARK[activity.state];
        return (
          <li key={activity.id} className="flex items-start gap-2">
            <span className={cx('shrink-0', mark.tone)}>{mark.glyph}</span>
            <span className="min-w-0 flex-1">
              <span className={activity.state === 'error' ? 'text-danger' : 'text-ink'}>
                {activity.detail}
              </span>
              {activity.state === 'error' && activity.result && (
                <span className="mt-0.5 block whitespace-pre-wrap text-ink-muted">
                  {activity.result}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ConnectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { provider, setProvider, setApiKey, apiKeyPresent } = useAiStore();
  const [key, setKey] = useState('');

  useEffect(() => {
    if (open) setKey(readApiKey());
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect a model provider"
      description="Forge does not ship an API key. Bring your own, or point at a proxy you control."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              setApiKey(key);
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label="Provider"
          value={provider.kind}
          onChange={(event) => setProvider({ kind: event.target.value as ProviderKind })}
          options={[
            { value: 'none', label: 'Not connected' },
            { value: 'anthropic', label: 'Anthropic Messages API' },
            { value: 'openai', label: 'OpenAI-compatible endpoint' },
          ]}
        />
        <Input
          label="Model"
          value={provider.model}
          onChange={(event) => setProvider({ model: event.target.value })}
          placeholder="claude-sonnet-5"
        />
        {provider.kind === 'openai' && (
          <Input
            label="Base URL"
            value={provider.baseUrl}
            onChange={(event) => setProvider({ baseUrl: event.target.value })}
            placeholder="https://your-proxy.example.com/v1"
            hint="Anything exposing POST /chat/completions."
          />
        )}
        {provider.kind !== 'none' && (
          <Input
            label="API key"
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={apiKeyPresent ? '•••••••• (stored for this tab)' : 'sk-…'}
            hint="Held in sessionStorage only. It is never written to disk, synced, or sent anywhere except your chosen provider."
          />
        )}
        {provider.kind === 'anthropic' && (
          <p className="rounded border border-caution/30 bg-caution/5 p-2.5 text-sm text-ink-muted">
            Calling Anthropic straight from a browser exposes your key to any script on this page
            and requires direct browser access on your account. A proxy you control is safer.
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * Named tasks, and what each turn will send.
 *
 * A workflow that cannot run says why instead of failing after the fact, and
 * the context row shows the real size of what leaves the browser — the same
 * sections the request is built from, not an estimate of them.
 */
function WorkflowBar({ disabled }: { disabled: boolean }) {
  const runWorkflow = useAiStore((s) => s.runWorkflow);
  const context = useAiStore((s) => s.context);
  const setContextSource = useAiStore((s) => s.setContextSource);
  const selection = useAiStore((s) => s.selection);
  const activePath = useEditorStore((s) => s.activePath);
  const problems = useEditorStore((s) => s.problems);
  const clean = useGitStore((s) => s.status.clean);

  const scope: WorkflowScope = {
    path: activePath,
    selection,
    hasDiagnostics: problems.length > 0,
    hasChanges: !clean,
  };
  const sections = currentContextSections();
  const size = contextSize(sections);

  return (
    <div className="border-b border-line">
      <div className="flex flex-wrap gap-1 px-2.5 py-2">
        {WORKFLOWS.map((workflow) => {
          const blocked = workflow.unavailable(scope);
          return (
            <Tooltip key={workflow.id} content={blocked ?? workflow.description}>
              <button
                type="button"
                disabled={disabled || Boolean(blocked)}
                onClick={() => void runWorkflow(workflow.id)}
                className={cx(
                  'rounded border border-line px-1.5 py-0.5 text-sm transition-colors',
                  'text-ink-muted hover:border-accent hover:text-ink',
                  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line',
                )}
              >
                {workflow.label}
              </button>
            </Tooltip>
          );
        })}
      </div>

      <details className="px-2.5 pb-2">
        <summary className="cursor-pointer text-sm text-ink-faint">
          Context · {sections.length} source{sections.length === 1 ? '' : 's'} ·{' '}
          {size > 1000 ? `${Math.round(size / 100) / 10}k` : size} chars
        </summary>
        <p className="mt-1 text-sm text-ink-faint">
          Protected files are never sent, whatever is selected here.
        </p>
        <div className="mt-1.5 space-y-1">
          {(Object.keys(CONTEXT_LABELS) as ContextSource[]).map((source) => (
            <label key={source} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={context[source]}
                onChange={(event) => setContextSource(source, event.target.checked)}
                className="mt-0.5 h-3 w-3 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="text-ink">{CONTEXT_LABELS[source]}</span>
                <span className="block text-ink-faint">{CONTEXT_DESCRIPTIONS[source]}</span>
              </span>
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

export function AssistantPanel() {
  const {
    messages,
    running,
    provider,
    apiKeyPresent,
    allowDestructive,
    setAllowDestructive,
    send,
    cancel,
    reset,
  } = useAiStore();
  const error = useAiStore((s) => s.error);
  const errorKind = useAiStore((s) => s.errorKind);
  const retryAt = useAiStore((s) => s.retryAt);
  const retry = useAiStore((s) => s.retry);
  const canRetry = useAiStore((s) => Boolean(s.lastPrompt) && !s.running);
  const canWrite = useFileStore((s) => s.canWrite());
  const [prompt, setPrompt] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const connected = provider.kind !== 'none' && (provider.kind === 'openai' || apiKeyPresent);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    if (!prompt.trim() || running) return;
    const text = prompt;
    setPrompt('');
    void send(text);
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Assistant"
        actions={
          <>
            <IconButton
              label="Provider settings"
              icon={<Plug className="h-3.5 w-3.5" />}
              onClick={() => setConnectOpen(true)}
            />
            <IconButton
              label="Clear conversation"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              disabled={!messages.length}
              onClick={reset}
            />
          </>
        }
      />

      {!connected && (
        <div className="border-b border-line bg-caution/5 p-2.5">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" />
            <div>
              <p className="text-base text-ink">No model provider connected</p>
              <p className="mt-0.5 text-sm text-ink-muted">
                The assistant will not answer without one. Nothing is generated locally.
              </p>
              <Button size="xs" variant="primary" className="mt-2" onClick={() => setConnectOpen(true)}>
                Connect a provider
              </Button>
            </div>
          </div>
        </div>
      )}

      {connected && !canWrite && (
        <p className="border-b border-line px-2.5 py-1.5 text-sm text-ink-muted">
          You have read-only access, so the assistant can read and search but cannot edit files.
        </p>
      )}

      {connected && canWrite && (
        <div className="border-b border-line px-2.5 py-1">
          <Switch
            label="Allow destructive actions"
            description="Off by default. Required before the assistant may delete a file or run rm. Resets when you reload."
            checked={allowDestructive}
            onChange={setAllowDestructive}
          />
        </div>
      )}

      {connected && <WorkflowBar disabled={running} />}

      <AgentTaskBar />

      <div ref={scrollRef} className="scrollbar-thin flex-1 overflow-y-auto p-2.5">
        {!messages.length ? (
          <EmptyState
            icon={<Bot className="h-4 w-4" />}
            title="Ask about this project"
            description="The assistant reads and edits your real files through tools, and shows every call it makes."
          />
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <article key={message.id} className="animate-slide-up">
                <div className="flex items-center gap-1.5">
                  {message.role === 'user' ? (
                    <User className="h-3 w-3 text-ink-faint" />
                  ) : (
                    <Bot className={cx('h-3 w-3', message.role === 'error' ? 'text-danger' : 'text-accent')} />
                  )}
                  <span className="panel-label">
                    {message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Assistant'}
                  </span>
                </div>
                {message.role === 'assistant' && <ActivityList activities={message.activities} />}
                {message.text && (
                  <p
                    className={cx(
                      'mt-1.5 whitespace-pre-wrap break-words text-base',
                      message.role === 'error' ? 'text-danger' : 'text-ink',
                    )}
                  >
                    {message.text}
                  </p>
                )}
                {message.role === 'assistant' && !message.text && running && (
                  <p className="mt-1.5 text-base text-ink-faint">Working…</p>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {error && errorKind && !running && (
        <div role="alert" className="border-t border-danger/40 bg-danger/5 p-2.5">
          <p className="flex items-start gap-1.5 text-base text-ink">
            <AlertCircle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            <span>
              {ERROR_ADVICE[errorKind]}
              {errorKind === 'rate-limited' && retryHint(retryAt)}
            </span>
          </p>
          {canRetry && errorKind !== 'not-configured' && errorKind !== 'unauthorized' && (
            <Button size="xs" className="mt-2" leading={<RotateCcw className="h-3 w-3" />} onClick={() => void retry()}>
              Retry
            </Button>
          )}
        </div>
      )}

      <div className="border-t border-line p-2.5">
        <div className="flex items-end gap-1.5">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={2}
            disabled={!connected}
            placeholder={connected ? 'Ask, or describe a change…' : 'Connect a provider to start'}
            aria-label="Message the assistant"
            className="flex-1 resize-none rounded border border-line bg-surface-sunken px-2 py-1.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-60"
          />
          {running ? (
            <IconButton
              label="Stop the assistant"
              size="md"
              icon={<Square className="h-3.5 w-3.5" />}
              onClick={cancel}
            />
          ) : (
            <IconButton
              label="Send message"
              size="md"
              disabled={!connected || !prompt.trim()}
              icon={<Send className="h-3.5 w-3.5" />}
              onClick={submit}
            />
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Badge tone={connected ? 'positive' : 'neutral'}>
            {connected ? provider.model : 'not connected'}
          </Badge>
          <span className="text-sm text-ink-faint">Shift + Enter for a new line</span>
        </div>
      </div>

      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
    </div>
  );
}
