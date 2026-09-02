import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpCircle, Package, Search, Trash2 } from 'lucide-react';
import { PanelHeader, EmptyState, Spinner, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { useFileStore } from '@/stores/fileStore';
import { toast } from '@/stores/toastStore';
import {
  addDependency,
  listInstalled,
  removeDependency,
  resolveVersion,
  searchPackages,
} from '@/lib/packages';
import type { RegistryPackage } from '@/types';
import { cx, debounce, errorMessage } from '@/lib/utils';

/**
 * Dependency management against the live npm registry.
 *
 * Installing writes the resolved version into package.json; the preview then
 * loads that exact version from esm.sh. There is no node_modules in a browser,
 * and the footer says so rather than implying a real install happened.
 */
export function PackagesPanel() {
  const files = useFileStore((s) => s.files);
  const canWrite = useFileStore((s) => s.canWrite());
  const writeFile = useFileStore((s) => s.writeFile);
  const createFile = useFileStore((s) => s.createFile);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryPackage[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const manifest = files['package.json'];
  const installed = useMemo(() => listInstalled(manifest), [manifest]);
  const manifestInvalid = useMemo(() => {
    if (!manifest) return null;
    try {
      JSON.parse(manifest);
      return null;
    } catch (caught) {
      return errorMessage(caught);
    }
  }, [manifest]);

  const runSearch = useMemo(
    () =>
      debounce((term: string) => {
        abortRef.current?.abort();
        if (!term.trim()) {
          setResults([]);
          setSearching(false);
          return;
        }
        const controller = new AbortController();
        abortRef.current = controller;
        setSearching(true);
        setError(null);
        searchPackages(term, controller.signal)
          .then((packages) => {
            setResults(packages);
            setSearching(false);
          })
          .catch((caught) => {
            if (controller.signal.aborted) return;
            setError(errorMessage(caught));
            setSearching(false);
          });
      }, 300),
    [],
  );

  useEffect(() => {
    runSearch(query);
    return () => runSearch.cancel();
  }, [query, runSearch]);

  const writeManifest = (next: string) => {
    if ('package.json' in files) writeFile('package.json', next);
    else createFile('package.json', next);
  };

  const install = async (name: string) => {
    setPendingName(name);
    try {
      const result = await addDependency(manifest, name, false);
      writeManifest(result.manifest);
      toast.success('Added to package.json', `${result.name}@${result.version}`);
    } catch (caught) {
      toast.error('Install failed', errorMessage(caught));
    } finally {
      setPendingName(null);
    }
  };

  const update = async (name: string) => {
    setPendingName(name);
    try {
      const version = await resolveVersion(name);
      const result = await addDependency(manifest, `${name}@${version}`, false);
      writeManifest(result.manifest);
      toast.success('Updated', `${name}@${version}`);
    } catch (caught) {
      toast.error('Update failed', errorMessage(caught));
    } finally {
      setPendingName(null);
    }
  };

  const uninstall = (name: string) => {
    try {
      writeManifest(removeDependency(manifest, name));
      toast.success('Removed', name);
    } catch (caught) {
      toast.error('Could not remove', errorMessage(caught));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Packages" />

      <div className="border-b border-line p-2.5">
        <div className="relative">
          <Search aria-hidden className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            aria-label="Search npm packages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search npm"
            className="h-7 w-full rounded border border-line bg-surface-sunken pl-7 pr-2 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {manifestInvalid && (
          <p role="alert" className="m-2.5 rounded border border-danger/40 bg-danger/5 p-2 text-sm text-danger">
            package.json is not valid JSON, so dependencies cannot be read: {manifestInvalid}
          </p>
        )}

        {query ? (
          <>
            {error && (
              <p role="alert" className="m-2.5 rounded border border-danger/40 bg-danger/5 p-2 text-sm text-danger">
                {error}
              </p>
            )}
            {searching ? (
              <div className="flex items-center gap-2 p-3 text-sm text-ink-faint">
                <Spinner className="h-3.5 w-3.5" /> Searching npm…
              </div>
            ) : !results.length && !error ? (
              <EmptyState title="No packages found" description={`Nothing on npm matches "${query}".`} />
            ) : (
              results.map((item) => {
                const already = installed.some((p) => p.name === item.name);
                return (
                  <article key={item.name} className="border-b border-line px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-base font-medium text-ink">{item.name}</span>
                          <span className="shrink-0 font-mono text-sm text-ink-faint">
                            {item.version}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-sm text-ink-muted">
                          {item.description || 'No description'}
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant={already ? 'outline' : 'primary'}
                        disabled={!canWrite || already || pendingName === item.name}
                        loading={pendingName === item.name}
                        onClick={() => void install(item.name)}
                      >
                        {already ? 'Added' : 'Add'}
                      </Button>
                    </div>
                  </article>
                );
              })
            )}
          </>
        ) : (
          <>
            <p className="panel-label px-2.5 py-2">
              Declared dependencies ({installed.length})
            </p>
            {!installed.length ? (
              <EmptyState
                icon={<Package className="h-4 w-4" />}
                title="No dependencies"
                description="Search npm above to add one to package.json."
              />
            ) : (
              installed.map((entry) => (
                <div
                  key={entry.name}
                  className={cx(
                    'group flex items-center gap-2 border-b border-line px-2.5 py-1.5',
                    'hover:bg-surface-raised',
                  )}
                >
                  <Package aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-base text-ink">{entry.name}</span>
                  {entry.dev && <Badge>dev</Badge>}
                  <span className="shrink-0 font-mono text-sm text-ink-faint">{entry.version}</span>
                  <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <IconButton
                      label={`Update ${entry.name} to latest`}
                      size="xs"
                      disabled={!canWrite || pendingName === entry.name}
                      icon={<ArrowUpCircle className="h-3 w-3" />}
                      onClick={() => void update(entry.name)}
                    />
                    <IconButton
                      label={`Remove ${entry.name}`}
                      size="xs"
                      tone="danger"
                      disabled={!canWrite}
                      icon={<Trash2 className="h-3 w-3" />}
                      onClick={() => uninstall(entry.name)}
                    />
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>

      <p className="border-t border-line px-2.5 py-1.5 text-sm text-ink-faint">
        Versions are resolved from registry.npmjs.org and written to package.json. There is no
        node_modules here — the preview imports each package from esm.sh at the pinned version.
      </p>
    </div>
  );
}
