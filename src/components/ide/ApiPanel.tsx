import { useMemo, useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { PanelHeader, EmptyState, Badge, Spinner } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { useApiStore, type EnvironmentName } from '@/stores/apiStore';
import {
  HTTP_METHODS,
  buildRequest,
  formatBody,
  redactSecrets,
  referencedVariables,
  statusTone,
  type ApiRequest,
  type HttpMethod,
  type KeyValue,
  type Variable,
} from '@/lib/api/request';
import { uid, cx } from '@/lib/utils';

/**
 * Sending an HTTP request, from this browser.
 *
 * The request goes out through the page's own `fetch` — not relayed through a
 * server — so CORS applies and a service that does not allow this origin cannot
 * be called from here. That limit is deliberate: a server-side relay would
 * remove it and, in exchange, become a thing an arbitrary URL could be aimed
 * at. The panel explains that where the failure appears, because "failed to
 * fetch" is otherwise read as "the API is down".
 *
 * Secret variables are held for this session only. The panel says so beside the
 * field rather than letting somebody discover it as a 401 after a reload.
 */

function PairEditor({
  label,
  pairs,
  onChange,
}: {
  label: string;
  pairs: KeyValue[];
  onChange: (pairs: KeyValue[]) => void;
}) {
  const update = (id: string, patch: Partial<KeyValue>) =>
    onChange(pairs.map((pair) => (pair.id === id ? { ...pair, ...patch } : pair)));

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="panel-label">{label}</p>
        <IconButton
          label={`Add ${label.toLowerCase()}`}
          size="xs"
          icon={<Plus className="h-3 w-3" />}
          onClick={() => onChange([...pairs, { id: uid('kv'), key: '', value: '', enabled: true }])}
        />
      </div>
      {pairs.length === 0 ? (
        <p className="py-1 text-sm text-ink-faint">
          <span>None.</span>
        </p>
      ) : (
        pairs.map((pair) => (
          <div key={pair.id} className="mt-1 flex items-center gap-1">
            <input
              type="checkbox"
              aria-label={`Send ${pair.key || 'this entry'}`}
              checked={pair.enabled}
              onChange={(event) => update(pair.id, { enabled: event.target.checked })}
              className="h-3 w-3 shrink-0 accent-accent"
            />
            <input
              aria-label={`${label} name`}
              value={pair.key}
              placeholder="name"
              onChange={(event) => update(pair.id, { key: event.target.value })}
              className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <input
              aria-label={`${label} value`}
              value={pair.value}
              placeholder="value"
              onChange={(event) => update(pair.id, { value: event.target.value })}
              className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <IconButton
              label={`Remove ${pair.key || 'entry'}`}
              size="xs"
              icon={<Trash2 className="h-3 w-3" />}
              onClick={() => onChange(pairs.filter((entry) => entry.id !== pair.id))}
            />
          </div>
        ))
      )}
    </div>
  );
}

function VariableEditor({
  environment,
  variables,
  onChange,
}: {
  environment: EnvironmentName;
  variables: Variable[];
  onChange: (variables: Variable[]) => void;
}) {
  const update = (key: string, patch: Partial<Variable>) =>
    onChange(variables.map((variable) => (variable.key === key ? { ...variable, ...patch } : variable)));

  const missingSecret = variables.some((variable) => variable.secret && !variable.value);

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="panel-label">Variables · {environment}</p>
        <IconButton
          label="Add variable"
          size="xs"
          icon={<Plus className="h-3 w-3" />}
          onClick={() => onChange([...variables, { key: '', value: '', secret: false }])}
        />
      </div>

      {variables.map((variable, index) => (
        <div key={index} className="mt-1 flex items-center gap-1">
          <input
            aria-label="Variable name"
            value={variable.key}
            placeholder="name"
            onChange={(event) =>
              onChange(
                variables.map((entry, position) =>
                  position === index ? { ...entry, key: event.target.value } : entry,
                ),
              )
            }
            className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <input
            aria-label="Variable value"
            type={variable.secret ? 'password' : 'text'}
            value={variable.value}
            placeholder={variable.secret ? 'not stored' : 'value'}
            onChange={(event) => update(variable.key, { value: event.target.value })}
            className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <label className="flex shrink-0 items-center gap-1 text-sm text-ink-faint">
            <input
              type="checkbox"
              checked={variable.secret}
              onChange={(event) => update(variable.key, { secret: event.target.checked })}
              className="h-3 w-3 accent-accent"
            />
            <span>secret</span>
          </label>
          <IconButton
            label={`Remove ${variable.key || 'variable'}`}
            size="xs"
            icon={<Trash2 className="h-3 w-3" />}
            onClick={() => onChange(variables.filter((_, position) => position !== index))}
          />
        </div>
      ))}

      {/* Said here rather than discovered as a 401 after a reload. */}
      <p className="mt-1.5 text-sm text-ink-faint">
        <span>
          A variable marked secret is kept in memory for this session only and is never written to
          browser storage, where anything running on the page could read it. Its name is saved; its
          value is not.
          {missingSecret ? ' One or more secret values need entering again.' : ''}
        </span>
      </p>
    </div>
  );
}

export function ApiPanel() {
  const {
    requests,
    activeId,
    environment,
    running,
    response,
    failure,
    history,
    createRequest,
    updateRequest,
    removeRequest,
    select,
    setEnvironment,
    setVariables,
    send,
  } = useApiStore();
  const variables = useApiStore((s) => s.variables[s.environment] ?? []);
  const [tab, setTab] = useState<'request' | 'variables' | 'history'>('request');

  const active = requests.find((request) => request.id === activeId) ?? null;

  // The request as it will actually go out, with secrets masked. Built here so
  // a bad URL is a message beside the field rather than a thrown fetch error.
  const preview = useMemo(
    () => (active ? buildRequest(active, variables) : null),
    [active, variables],
  );

  const unresolved = useMemo(() => {
    if (!active) return [];
    const referenced = referencedVariables(
      `${active.url} ${active.body} ${active.headers.map((h) => `${h.key}${h.value}`).join(' ')}`,
    );
    return referenced.filter((name) => !variables.some((variable) => variable.key === name));
  }, [active, variables]);

  const set = (patch: Partial<ApiRequest>) => active && updateRequest(active.id, patch);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="API"
        actions={
          <IconButton
            label="New request"
            size="xs"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => createRequest()}
          />
        }
      />

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <select
          aria-label="Environment"
          value={environment}
          onChange={(event) => setEnvironment(event.target.value as EnvironmentName)}
          className="h-6 shrink-0 rounded border border-line bg-surface-sunken px-1.5 text-sm text-ink focus:border-accent focus:outline-none"
        >
          <option value="development">development</option>
          <option value="preview">preview</option>
          <option value="production">production</option>
        </select>
        <select
          aria-label="Saved request"
          value={activeId ?? ''}
          onChange={(event) => select(event.target.value)}
          disabled={!requests.length}
          className="h-6 min-w-0 flex-1 truncate rounded border border-line bg-surface-sunken px-1.5 text-sm text-ink focus:border-accent focus:outline-none"
        >
          {!requests.length && <option value="">No saved requests</option>}
          {requests.map((request) => (
            <option key={request.id} value={request.id}>
              {request.method} {request.name}
            </option>
          ))}
        </select>
        {active && (
          <IconButton
            label={`Delete ${active.name}`}
            size="xs"
            icon={<Trash2 className="h-3 w-3" />}
            onClick={() => removeRequest(active.id)}
          />
        )}
      </div>

      {!active ? (
        <EmptyState
          icon={<Send className="h-4 w-4" />}
          title="No request yet"
          description="Create one to send a real HTTP request from this browser."
          action={
            <Button size="sm" variant="primary" onClick={() => createRequest()}>
              New request
            </Button>
          }
        />
      ) : (
        <>
          <div className="shrink-0 space-y-1.5 border-b border-line px-2.5 py-1.5">
            <input
              aria-label="Request name"
              value={active.name}
              onChange={(event) => set({ name: event.target.value })}
              className="h-6 w-full rounded border border-line bg-surface-sunken px-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <div className="flex items-center gap-1">
              <select
                aria-label="Method"
                value={active.method}
                onChange={(event) => set({ method: event.target.value as HttpMethod })}
                className="h-7 shrink-0 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
              >
                {HTTP_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
              <input
                aria-label="URL"
                value={active.url}
                placeholder="https://api.example.com/v1/things"
                onChange={(event) => set({ url: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void send();
                }}
                className="h-7 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-2 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              />
              <Button
                size="sm"
                variant="primary"
                loading={running}
                disabled={running}
                leading={<Send className="h-3 w-3" />}
                onClick={() => void send()}
              >
                Send
              </Button>
            </div>

            {preview?.error && (
              <p role="alert" className="text-sm text-danger">
                <span>{preview.error}</span>
              </p>
            )}
            {unresolved.length > 0 && (
              <p className="text-sm text-caution">
                <span>
                  {`No value for ${unresolved.map((name) => `{{${name}}}`).join(', ')} — it will be sent as written.`}
                </span>
              </p>
            )}
          </div>

          <div role="tablist" aria-label="Request view" className="flex shrink-0 border-b border-line">
            {(
              [
                ['request', 'Request'],
                ['variables', 'Variables'],
                ['history', 'History'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cx(
                  'tap-target flex-1 px-2 py-1.5 text-sm transition-colors',
                  tab === value
                    ? 'border-b-2 border-accent text-ink'
                    : 'border-b-2 border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {tab === 'request' && (
              <div className="space-y-3 p-2.5">
                <div>
                  <p className="panel-label">Authentication</p>
                  <select
                    aria-label="Authentication"
                    value={active.auth.kind}
                    onChange={(event) => {
                      const kind = event.target.value;
                      set({
                        auth:
                          kind === 'bearer'
                            ? { kind: 'bearer', token: '' }
                            : kind === 'basic'
                              ? { kind: 'basic', username: '', password: '' }
                              : kind === 'header'
                                ? { kind: 'header', name: '', value: '' }
                                : { kind: 'none' },
                      });
                    }}
                    className="mt-1 h-6 w-full rounded border border-line bg-surface-sunken px-1.5 text-sm text-ink focus:border-accent focus:outline-none"
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer token</option>
                    <option value="basic">Basic</option>
                    <option value="header">Custom header</option>
                  </select>

                  {active.auth.kind === 'bearer' && (
                    <input
                      aria-label="Bearer token"
                      value={active.auth.token}
                      placeholder="{{token}}"
                      onChange={(event) => set({ auth: { kind: 'bearer', token: event.target.value } })}
                      className="mt-1 h-6 w-full rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                    />
                  )}
                  {active.auth.kind === 'basic' && (
                    <div className="mt-1 flex gap-1">
                      <input
                        aria-label="Username"
                        value={active.auth.username}
                        placeholder="username"
                        onChange={(event) =>
                          set({
                            auth: { ...(active.auth as { kind: 'basic'; username: string; password: string }), username: event.target.value },
                          })
                        }
                        className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                      />
                      <input
                        aria-label="Password"
                        type="password"
                        value={active.auth.password}
                        placeholder="{{password}}"
                        onChange={(event) =>
                          set({
                            auth: { ...(active.auth as { kind: 'basic'; username: string; password: string }), password: event.target.value },
                          })
                        }
                        className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                      />
                    </div>
                  )}
                  {active.auth.kind === 'header' && (
                    <div className="mt-1 flex gap-1">
                      <input
                        aria-label="Header name"
                        value={active.auth.name}
                        placeholder="X-Api-Key"
                        onChange={(event) =>
                          set({ auth: { ...(active.auth as { kind: 'header'; name: string; value: string }), name: event.target.value } })
                        }
                        className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                      />
                      <input
                        aria-label="Header value"
                        value={active.auth.value}
                        placeholder="{{apiKey}}"
                        onChange={(event) =>
                          set({ auth: { ...(active.auth as { kind: 'header'; name: string; value: string }), value: event.target.value } })
                        }
                        className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                      />
                    </div>
                  )}
                  <p className="mt-1 text-sm text-ink-faint">
                    <span>Reference a secret as {'{{name}}'} rather than typing it here — a value typed into a request is saved with it.</span>
                  </p>
                </div>

                <PairEditor label="Headers" pairs={active.headers} onChange={(headers) => set({ headers })} />
                <PairEditor label="Query" pairs={active.params} onChange={(params) => set({ params })} />

                {active.method !== 'GET' && active.method !== 'HEAD' && (
                  <div>
                    <p className="panel-label">Body</p>
                    <textarea
                      aria-label="Request body"
                      value={active.body}
                      rows={6}
                      placeholder='{"name":"value"}'
                      onChange={(event) => set({ body: event.target.value })}
                      className="mt-1 w-full resize-y rounded border border-line bg-surface-sunken p-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                    />
                  </div>
                )}

                {preview && !preview.error && (
                  <div>
                    <p className="panel-label">Will send</p>
                    {/* Secrets masked: this is on screen and in screenshots. */}
                    <pre className="scrollbar-thin mt-1 overflow-x-auto rounded border border-line bg-surface-sunken p-1.5 font-mono text-sm text-ink-muted">
                      {`${preview.method} ${redactSecrets(preview.url, variables)}`}
                      {Object.entries(preview.headers).map(
                        ([key, value]) => `\n${key}: ${redactSecrets(value, variables)}`,
                      )}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {tab === 'variables' && (
              <div className="p-2.5">
                <VariableEditor
                  environment={environment}
                  variables={variables}
                  onChange={(next) => setVariables(environment, next)}
                />
              </div>
            )}

            {tab === 'history' &&
              (!history.length ? (
                <EmptyState title="Nothing sent yet" />
              ) : (
                history.map((entry) => (
                  <div key={entry.id} className="border-b border-line px-2.5 py-1.5">
                    <p className="flex items-center gap-1.5 text-sm">
                      <span className="font-mono text-ink-faint">{entry.method}</span>
                      {entry.status !== null ? (
                        <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
                      ) : (
                        <Badge tone="danger">failed</Badge>
                      )}
                      <span className="tabular-nums text-ink-faint">{entry.durationMs}ms</span>
                    </p>
                    <p className="mt-0.5 truncate font-mono text-sm text-ink-muted">{entry.url}</p>
                    {entry.failure && <p className="text-sm text-danger">{entry.failure}</p>}
                  </div>
                ))
              ))}
          </div>

          {(response || failure || running) && tab === 'request' && (
            <div className="max-h-64 shrink-0 overflow-hidden border-t border-line">
              {running ? (
                <p className="flex items-center gap-2 px-2.5 py-2 text-sm text-ink-faint">
                  <Spinner className="h-3 w-3" />
                  <span>Sending…</span>
                </p>
              ) : failure ? (
                <div role="alert" className="px-2.5 py-2">
                  <Badge tone="danger">{failure.kind}</Badge>
                  <p className="mt-1 text-sm text-danger">{failure.message}</p>
                </div>
              ) : response ? (
                <div className="flex h-full min-h-0 flex-col">
                  <p className="flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 py-1 text-sm">
                    <Badge tone={statusTone(response.status)}>
                      {response.status} {response.statusText}
                    </Badge>
                    <span className="tabular-nums text-ink-faint">{response.durationMs}ms</span>
                    <span className="tabular-nums text-ink-faint">{response.size} bytes</span>
                    {response.truncated && <Badge tone="caution">truncated</Badge>}
                  </p>
                  <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-surface-sunken p-2 font-mono text-sm text-ink-muted">
                    {formatBody(response.body) || '(empty body)'}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
