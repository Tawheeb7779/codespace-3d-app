import { useState } from 'react';
import { AlertCircle, Package, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Field';
import { useExtensionStore } from '@/stores/extensionStore';
import {
  CAPABILITY_LABEL,
  ENGINE_VERSION,
  FORBIDDEN_CAPABILITIES,
  WRITING_CAPABILITIES,
  type Capability,
} from '@/lib/extensions/registry';
import { toast } from '@/stores/toastStore';
import { cx, formatTimeAgo } from '@/lib/utils';

/**
 * Extensions, and the honest absence of a marketplace.
 *
 * No registry is configured in this deployment, so there is nothing to browse —
 * and the panel says that rather than listing extensions that cannot be
 * installed. A browsable catalogue of things that do not work is worse than an
 * empty panel: it promises a feature that does not exist.
 *
 * The architecture around that hole is real and is what the panel demonstrates.
 * A manifest can be installed by hand, is validated before anything happens,
 * arrives disabled, declares the capabilities it needs, and can be enabled,
 * configured, disabled and removed. A registry can be pointed at this without
 * the IDE changing.
 *
 * The capability list is the security model, and the refusals are shown as
 * plainly as the grants: an extension cannot ask for a terminal, the container,
 * the network or secrets, because an extension host that could reach those
 * would make every other boundary here decorative.
 */

function CapabilityRow({ capability }: { capability: Capability }) {
  const writes = WRITING_CAPABILITIES.includes(capability);
  return (
    <li className="flex items-center gap-1.5 text-sm">
      <span
        aria-hidden
        className={cx('h-1.5 w-1.5 shrink-0 rounded-full', writes ? 'bg-caution' : 'bg-ink-faint')}
      />
      <span className={writes ? 'text-caution' : 'text-ink-muted'}>
        {CAPABILITY_LABEL[capability]}
      </span>
    </li>
  );
}

export function ExtensionsPanel() {
  const { installed, lastProblems, install, uninstall, setEnabled, setSetting, clearProblems } =
    useExtensionStore();
  const registry = useExtensionStore((s) => s.registry());
  const [manifestText, setManifestText] = useState('');
  const [showInstall, setShowInstall] = useState(false);

  const attemptInstall = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestText);
    } catch {
      toast.error('That is not JSON', 'A manifest is a JSON object.');
      return;
    }
    const result = install(parsed);
    if (result.ok) {
      toast.success('Installed', 'It arrives disabled — enable it when you have read what it can do.');
      setManifestText('');
      setShowInstall(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Extensions"
        actions={
          <IconButton
            label="Install from a manifest"
            size="xs"
            icon={<Upload className="h-3.5 w-3.5" />}
            onClick={() => setShowInstall(!showInstall)}
          />
        }
      />

      {/* The absence, stated. Not a catalogue of things that cannot be had. */}
      {!registry.configured && (
        <p className="shrink-0 border-b border-line px-2.5 py-1.5 text-sm text-ink-faint">
          <span>{registry.reason}</span>
        </p>
      )}

      {showInstall && (
        <div className="shrink-0 space-y-1.5 border-b border-line p-2.5">
          <p className="panel-label">Install from a manifest</p>
          <textarea
            aria-label="Extension manifest"
            value={manifestText}
            rows={6}
            placeholder={`{\n  "id": "my-theme",\n  "name": "My theme",\n  "version": "1.0.0",\n  "category": "theme",\n  "capabilities": ["theme"],\n  "engine": "^1.0.0"\n}`}
            onChange={(event) => {
              setManifestText(event.target.value);
              clearProblems();
            }}
            className="w-full resize-y rounded border border-line bg-surface-sunken p-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <div className="flex gap-1.5">
            <Button size="xs" variant="primary" disabled={!manifestText.trim()} onClick={attemptInstall}>
              Install
            </Button>
            <Button size="xs" onClick={() => setShowInstall(false)}>
              Cancel
            </Button>
          </div>

          {lastProblems.length > 0 && (
            <div role="alert" className="rounded border border-danger/40 bg-danger/5 p-1.5">
              {lastProblems.map((problem, index) => (
                <p key={index} className="flex items-start gap-1.5 text-sm text-danger">
                  <AlertCircle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{problem.message}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!installed.length ? (
          <EmptyState
            icon={<Package className="h-4 w-4" />}
            title="Nothing installed"
            description="Install a manifest by hand to try the extension system, or configure a registry to browse."
          />
        ) : (
          installed.map((entry) => (
            <div key={entry.manifest.id} className="border-b border-line px-2.5 py-2">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-base text-ink">{entry.manifest.name}</span>
                    <span className="font-mono text-sm tabular-nums text-ink-faint">
                      {entry.manifest.version}
                    </span>
                    <Badge>{entry.manifest.category}</Badge>
                    {entry.enabled ? <Badge tone="positive">enabled</Badge> : <Badge>disabled</Badge>}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-muted">{entry.manifest.description}</p>
                  <p className="text-sm text-ink-faint">
                    <span>
                      {entry.manifest.author} · installed {formatTimeAgo(entry.installedAt)} · needs
                      TA CODE {entry.manifest.engine}
                    </span>
                  </p>
                </div>
                <IconButton
                  label={`Remove ${entry.manifest.name}`}
                  size="xs"
                  icon={<Trash2 className="h-3 w-3" />}
                  onClick={() => uninstall(entry.manifest.id)}
                />
              </div>

              <div className="mt-1.5">
                <p className="panel-label">What it can do</p>
                {entry.manifest.capabilities.length ? (
                  <ul className="mt-0.5">
                    {entry.manifest.capabilities.map((capability) => (
                      <CapabilityRow key={capability} capability={capability} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-faint">
                    <span>Nothing — it declared no capabilities.</span>
                  </p>
                )}
              </div>

              <div className="mt-1.5">
                <Switch
                  label="Enabled"
                  description={
                    entry.enabled
                      ? 'It has the capabilities above.'
                      : 'It has none of the capabilities above while disabled.'
                  }
                  checked={entry.enabled}
                  onChange={(enabled) => setEnabled(entry.manifest.id, enabled)}
                />
              </div>

              {entry.manifest.settings && entry.manifest.settings.length > 0 && (
                <div className="mt-1.5">
                  <p className="panel-label">Settings</p>
                  {entry.manifest.settings.map((setting) => (
                    <label
                      key={setting.key}
                      className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted"
                    >
                      <span className="min-w-0 flex-1 truncate">{setting.label}</span>
                      {setting.type === 'boolean' ? (
                        <input
                          type="checkbox"
                          checked={Boolean(entry.settings[setting.key])}
                          onChange={(event) =>
                            setSetting(entry.manifest.id, setting.key, event.target.checked)
                          }
                          className="h-3 w-3 shrink-0 accent-accent"
                        />
                      ) : (
                        <input
                          type={setting.type === 'number' ? 'number' : 'text'}
                          value={String(entry.settings[setting.key] ?? '')}
                          onChange={(event) =>
                            setSetting(
                              entry.manifest.id,
                              setting.key,
                              setting.type === 'number'
                                ? Number(event.target.value)
                                : event.target.value,
                            )
                          }
                          className="h-6 w-28 shrink-0 rounded border border-line bg-surface-sunken px-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                        />
                      )}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))
        )}

        {/* The refusals, as visible as the grants. */}
        <section className="border-t border-line px-2.5 py-2">
          <p className="panel-label flex items-center gap-1.5">
            <ShieldAlert aria-hidden className="h-3 w-3" />
            Outside the extension boundary
          </p>
          <p className="mt-0.5 text-sm text-ink-faint">
            <span>
              An extension cannot be granted {FORBIDDEN_CAPABILITIES.join(', ')}. A manifest asking
              for one is refused rather than installed with it dropped, because an extension host
              that could reach a terminal, the container or the network would make every other
              boundary in TA CODE decorative.
            </span>
          </p>
          <p className="mt-1 text-sm text-ink-faint">
            <span>This is TA CODE {ENGINE_VERSION}. Extensions declare the range they support.</span>
          </p>
        </section>
      </div>
    </div>
  );
}
