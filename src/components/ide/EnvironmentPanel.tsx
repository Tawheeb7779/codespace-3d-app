import { useMemo, useState } from 'react';
import { AlertCircle, FileWarning, KeyRound, Layers, Plus, Trash2 } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useEnvStore } from '@/stores/envStore';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABEL,
  ENVIRONMENT_NOTE,
  envFilesIn,
  findIssues,
  findUsages,
  isPublicPrefixed,
  vaultStatus,
} from '@/lib/env/manager';
import { findEnvFiles } from '@/lib/security/scan';
import { cx } from '@/lib/utils';

/**
 * Environments, and an honest account of where their secrets are.
 *
 * This does not hold secret values, and says so where a value field would
 * otherwise be. A browser has nowhere to put a production credential that a
 * browser cannot also read — TA CODE's own scanner flags that pattern in a
 * user's code, and a vault here that broke the same rule would be worth
 * nothing. What it manages is the part that can be managed truthfully: which
 * variables each environment needs, which are secret, where the code reads
 * them, and whether the files that would hold them are safe from git.
 *
 * Production changes are confirmed; the other two are not. A confirmation on
 * everything becomes a reflex, and the reflex is what makes the production one
 * useless.
 */

const SEVERITY_TONE = { high: 'text-danger', medium: 'text-caution', low: 'text-ink-faint' };

export function EnvironmentPanel() {
  const {
    variables,
    environment,
    pending,
    setEnvironment,
    addVariable,
    removeVariable,
    toggleEnvironment,
    setSecret,
    setNote,
    setValue,
    guarded,
    confirmPending,
    cancelPending,
  } = useEnvStore();
  const files = useFileStore((s) => s.files);
  const reveal = useEditorStore((s) => s.revealLocation);
  const [adding, setAdding] = useState('');
  const [tab, setTab] = useState<'variables' | 'issues' | 'files'>('variables');

  const usages = useMemo(() => findUsages(files), [files]);
  const issues = useMemo(
    () => findIssues(variables, usages, environment),
    [variables, usages, environment],
  );
  const envFiles = useMemo(() => envFilesIn(files), [files]);
  const unignored = useMemo(() => findEnvFiles(files), [files]);
  const status = useMemo(() => vaultStatus(variables, environment), [variables, environment]);

  const forEnvironment = variables.filter((variable) =>
    variable.environments.includes(environment),
  );

  const usagesOf = (key: string) => usages.filter((usage) => usage.key === key);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Environments"
        actions={issues.some((issue) => issue.severity === 'high') ? <Badge tone="danger">issues</Badge> : null}
      />

      <div className="shrink-0 border-b border-line px-2.5 py-1.5">
        <div className="flex gap-1">
          {ENVIRONMENTS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={environment === id}
              onClick={() => setEnvironment(id)}
              className={cx(
                'tap-target flex-1 rounded border px-1.5 py-1 text-sm transition-colors',
                environment === id
                  ? id === 'production'
                    ? 'border-danger bg-danger/10 text-danger'
                    : 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-ink-muted hover:text-ink',
              )}
            >
              {ENVIRONMENT_LABEL[id]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-sm text-ink-faint">
          <span>{ENVIRONMENT_NOTE[environment]}</span>
        </p>
      </div>

      <div role="tablist" aria-label="Environment view" className="flex shrink-0 border-b border-line">
        {(
          [
            ['variables', 'Variables'],
            ['issues', `Issues${issues.length ? ` (${issues.length})` : ''}`],
            ['files', 'Files'],
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
        {tab === 'variables' && (
          <>
            <div className="flex items-center gap-1 border-b border-line px-2.5 py-1.5">
              <input
                aria-label="New variable name"
                value={adding}
                placeholder="DATABASE_URL"
                onChange={(event) => setAdding(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !adding.trim()) return;
                  const key = adding.trim();
                  guarded(`add ${key} to ${ENVIRONMENT_LABEL[environment]}`, () => addVariable(key));
                  setAdding('');
                }}
                className="h-6 min-w-0 flex-1 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              />
              <IconButton
                label="Add variable"
                size="xs"
                disabled={!adding.trim()}
                icon={<Plus className="h-3 w-3" />}
                onClick={() => {
                  const key = adding.trim();
                  guarded(`add ${key} to ${ENVIRONMENT_LABEL[environment]}`, () => addVariable(key));
                  setAdding('');
                }}
              />
            </div>

            {!forEnvironment.length ? (
              <EmptyState
                icon={<Layers className="h-4 w-4" />}
                title={`Nothing declared for ${ENVIRONMENT_LABEL[environment]}`}
                description="Add the variables this environment needs. The Issues tab lists anything the code already reads."
              />
            ) : (
              forEnvironment.map((variable) => {
                const references = usagesOf(variable.key);
                const published = isPublicPrefixed(variable.key);
                return (
                  <div key={variable.key} className="border-b border-line px-2.5 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-base text-ink">
                        {variable.key}
                      </span>
                      {variable.secret && <Badge tone="caution">secret</Badge>}
                      {published && <Badge tone="accent">public</Badge>}
                      <IconButton
                        label={`Remove ${variable.key}`}
                        size="xs"
                        icon={<Trash2 className="h-3 w-3" />}
                        onClick={() =>
                          guarded(`remove ${variable.key} from ${ENVIRONMENT_LABEL[environment]}`, () =>
                            removeVariable(variable.key),
                          )
                        }
                      />
                    </div>

                    {variable.secret ? (
                      // Where a value field would be. Said plainly rather than
                      // rendered as an empty box that looks like a failed load.
                      <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-faint">
                        <KeyRound aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          The value is not held here, and cannot be — put it in {status.wherePlaced}.
                        </span>
                      </p>
                    ) : (
                      <input
                        aria-label={`${variable.key} value`}
                        value={variable.value}
                        placeholder="value"
                        onChange={(event) => setValue(variable.key, event.target.value)}
                        className="mt-1 h-6 w-full rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                      />
                    )}

                    <input
                      aria-label={`What ${variable.key} is for`}
                      value={variable.note}
                      placeholder="what it is for"
                      onChange={(event) => setNote(variable.key, event.target.value)}
                      className="mt-1 h-6 w-full rounded border border-line bg-surface-sunken px-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                    />

                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1 text-sm text-ink-faint">
                        <input
                          type="checkbox"
                          checked={variable.secret}
                          onChange={(event) => setSecret(variable.key, event.target.checked)}
                          className="h-3 w-3 accent-accent"
                        />
                        <span>secret</span>
                      </label>
                      {ENVIRONMENTS.map((id) => (
                        <label key={id} className="flex items-center gap-1 text-sm text-ink-faint">
                          <input
                            type="checkbox"
                            checked={variable.environments.includes(id)}
                            onChange={() =>
                              guarded(`change which environments declare ${variable.key}`, () =>
                                toggleEnvironment(variable.key, id),
                              )
                            }
                            className="h-3 w-3 accent-accent"
                          />
                          <span>{id}</span>
                        </label>
                      ))}
                    </div>

                    {references.length > 0 && (
                      <div className="mt-1.5">
                        <p className="panel-label">Read at</p>
                        {references.slice(0, 6).map((usage) => (
                          <button
                            key={`${usage.path}:${usage.line}`}
                            type="button"
                            onClick={() => reveal(usage.path, usage.line, 1)}
                            className="block w-full truncate text-left font-mono text-sm text-ink-faint hover:text-ink"
                          >
                            {usage.path}:{usage.line}
                            {usage.clientSide ? ' · reaches the browser' : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
        )}

        {tab === 'issues' &&
          (!issues.length ? (
            <EmptyState
              title="Nothing to report"
              description={`What the code reads and what ${ENVIRONMENT_LABEL[environment]} declares agree.`}
            />
          ) : (
            issues.map((issue) => (
              <div
                key={`${issue.kind}:${issue.key}`}
                className="flex items-start gap-2 border-b border-line px-2.5 py-1.5"
              >
                <AlertCircle
                  aria-hidden
                  className={cx('mt-0.5 h-3 w-3 shrink-0', SEVERITY_TONE[issue.severity])}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-base text-ink-muted">{issue.message}</p>
                  {usagesOf(issue.key).slice(0, 3).map((usage) => (
                    <button
                      key={`${usage.path}:${usage.line}`}
                      type="button"
                      onClick={() => reveal(usage.path, usage.line, 1)}
                      className="block truncate font-mono text-sm text-ink-faint hover:text-ink"
                    >
                      {usage.path}:{usage.line}
                    </button>
                  ))}
                </div>
                <Badge tone={issue.severity === 'high' ? 'danger' : issue.severity === 'medium' ? 'caution' : 'neutral'}>
                  {issue.severity}
                </Badge>
              </div>
            ))
          ))}

        {tab === 'files' && (
          <div className="py-1">
            {unignored.length > 0 && (
              <div className="mx-2.5 mb-2 rounded border border-danger/40 bg-danger/5 p-2">
                {unignored.map((finding) => (
                  <p key={finding.id} className="flex items-start gap-1.5 text-sm text-danger">
                    <FileWarning aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{finding.detail}</span>
                  </p>
                ))}
              </div>
            )}

            {!envFiles.length ? (
              <EmptyState
                title="No environment files"
                description="This project has no .env files. Values reach it from wherever it is run."
              />
            ) : (
              envFiles.map((file) => (
                <div key={file.path} className="border-b border-line px-2.5 py-1.5">
                  <p className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-base text-ink">
                      {file.path}
                    </span>
                    {file.example && <Badge>example</Badge>}
                  </p>
                  <p className="text-sm text-ink-faint">
                    {/* Names only. This never reads a value out of a .env file. */}
                    <span>
                      {file.keys.length
                        ? `Declares ${file.keys.join(', ')}. Values are not read.`
                        : 'Declares nothing.'}
                    </span>
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <p className="shrink-0 border-t border-line px-2.5 py-1.5 text-sm text-ink-faint">
        <span>
          {status.secretCount
            ? `${status.secretCount} secret${status.secretCount === 1 ? '' : 's'} for ${ENVIRONMENT_LABEL[environment]}. Their values belong in ${status.wherePlaced}, never here.`
            : 'No secrets declared for this environment.'}
        </span>
      </p>

      {/* Production only. Asking on every environment trains the reflex that
          makes this one useless. */}
      <Modal
        open={Boolean(pending)}
        onClose={cancelPending}
        title="Change production?"
        size="sm"
        footer={
          <>
            <Button onClick={cancelPending}>Cancel</Button>
            <Button variant="danger" onClick={confirmPending}>
              Change production
            </Button>
          </>
        }
      >
        <p className="text-base text-ink">
          This will {pending?.description}. Production is what users reach.
        </p>
      </Modal>
    </div>
  );
}
