import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Plug, Send, Square, Trash2, User } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, Select } from '@/components/ui/Field';
import { useAiStore } from '@/stores/aiStore';
import { useFileStore } from '@/stores/fileStore';
import { readApiKey, type ProviderKind } from '@/lib/ai/provider';
import type { AgentActivity } from '@/lib/ai/agent';
import { cx } from '@/lib/utils';

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

export function AssistantPanel() {
  const { messages, running, provider, apiKeyPresent, send, cancel, reset } = useAiStore();
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
