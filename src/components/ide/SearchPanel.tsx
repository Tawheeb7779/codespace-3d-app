import { useEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, Regex, Replace, WholeWord } from 'lucide-react';
import { PanelHeader, EmptyState, Spinner } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ide/FileIcon';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { toast } from '@/stores/toastStore';
import {
  DEFAULT_SEARCH_OPTIONS,
  replaceAll,
  type SearchOptions,
  type SearchOutcome,
} from '@/lib/search';
import type { SearchMatch } from '@/types';
import { cx, debounce, errorMessage } from '@/lib/utils';
import { basename, dirname } from '@/lib/vfs';

/**
 * Project-wide search. The scan runs in a worker so a large project cannot
 * block typing; results stream back grouped by file.
 */
export function SearchPanel() {
  const files = useFileStore((s) => s.files);
  const canWrite = useFileStore((s) => s.canWrite());
  const writeFile = useFileStore((s) => s.writeFile);
  const reveal = useEditorStore((s) => s.revealLocation);

  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL('@/workers/search.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as
        | { id: number; ok: true; result: SearchOutcome }
        | { id: number; ok: false; error: string };
      if (data.id !== requestId.current) return;
      setBusy(false);
      if (data.ok) {
        setOutcome(data.result);
        setError(null);
      } else {
        setOutcome(null);
        setError(data.error);
      }
    };
    worker.onerror = (event) => {
      setBusy(false);
      setError(event.message || 'The search worker failed to start.');
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const run = useMemo(
    () =>
      debounce((next: SearchOptions, snapshot: Record<string, string>) => {
        if (!next.query) {
          setOutcome(null);
          setError(null);
          setBusy(false);
          return;
        }
        requestId.current += 1;
        setBusy(true);
        workerRef.current?.postMessage({ id: requestId.current, files: snapshot, options: next });
      }, 220),
    [],
  );

  useEffect(() => {
    run(options, files);
    return () => run.cancel();
  }, [options, files, run]);

  const grouped = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const match of outcome?.matches ?? []) {
      const list = map.get(match.path);
      if (list) list.push(match);
      else map.set(match.path, [match]);
    }
    return [...map.entries()];
  }, [outcome]);

  const applyReplaceAll = () => {
    try {
      const result = replaceAll(files, options, replacement);
      if (!result.changed.length) {
        toast.info('Nothing to replace');
        return;
      }
      for (const [path, content] of Object.entries(result.files)) writeFile(path, content);
      toast.success(
        `Replaced ${result.replacements} occurrence${result.replacements === 1 ? '' : 's'}`,
        `${result.changed.length} file${result.changed.length === 1 ? '' : 's'} updated`,
      );
    } catch (caught) {
      toast.error('Replace failed', errorMessage(caught));
    }
  };

  const toggleOption = (key: keyof SearchOptions) =>
    setOptions((current) => ({ ...current, [key]: !current[key] }));

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Search" />

      <div className="space-y-2 border-b border-line p-2.5">
        <div className="relative">
          <input
            autoFocus
            aria-label="Search across files"
            value={options.query}
            onChange={(event) => setOptions((c) => ({ ...c, query: event.target.value }))}
            placeholder="Search"
            className="h-7 w-full rounded border border-line bg-surface-sunken pl-2 pr-20 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5">
            <IconButton
              label="Match case"
              size="xs"
              active={options.caseSensitive}
              icon={<CaseSensitive className="h-3 w-3" />}
              onClick={() => toggleOption('caseSensitive')}
            />
            <IconButton
              label="Match whole word"
              size="xs"
              active={options.wholeWord}
              icon={<WholeWord className="h-3 w-3" />}
              onClick={() => toggleOption('wholeWord')}
            />
            <IconButton
              label="Use regular expression"
              size="xs"
              active={options.regex}
              icon={<Regex className="h-3 w-3" />}
              onClick={() => toggleOption('regex')}
            />
          </div>
        </div>

        <div className="flex gap-1.5">
          <IconButton
            label={showReplace ? 'Hide replace' : 'Show replace'}
            active={showReplace}
            icon={<Replace className="h-3.5 w-3.5" />}
            onClick={() => setShowReplace((value) => !value)}
          />
          {showReplace && (
            <>
              <input
                aria-label="Replace with"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                placeholder="Replace"
                className="h-7 flex-1 rounded border border-line bg-surface-sunken px-2 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              />
              <Button
                size="sm"
                disabled={!canWrite || !outcome?.matches.length}
                onClick={applyReplaceAll}
              >
                All
              </Button>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <input
            aria-label="Files to include"
            value={options.include}
            onChange={(event) => setOptions((c) => ({ ...c, include: event.target.value }))}
            placeholder="include: *.ts, src/**"
            className="h-6 rounded border border-line bg-surface-sunken px-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
          <input
            aria-label="Files to exclude"
            value={options.exclude}
            onChange={(event) => setOptions((c) => ({ ...c, exclude: event.target.value }))}
            placeholder="exclude: *.md"
            className="h-6 rounded border border-line bg-surface-sunken px-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="m-3 rounded border border-danger/40 bg-danger/5 p-2 text-sm text-danger">
            {error}
          </p>
        ) : busy ? (
          <div className="flex items-center gap-2 p-3 text-sm text-ink-faint">
            <Spinner className="h-3.5 w-3.5" /> Searching…
          </div>
        ) : !options.query ? (
          <EmptyState title="Search your project" description="Results appear as you type." />
        ) : !grouped.length ? (
          <EmptyState title="No results" description={`Nothing matches "${options.query}".`} />
        ) : (
          <>
            <p className="px-3 py-2 text-sm text-ink-faint">
              {outcome?.matches.length} result{outcome?.matches.length === 1 ? '' : 's'} in{' '}
              {grouped.length} file{grouped.length === 1 ? '' : 's'}
              {outcome?.truncated && ' (truncated)'}
            </p>
            {grouped.map(([path, matches]) => (
              <section key={path}>
                <div className="sticky top-0 flex items-center gap-1.5 bg-surface px-2.5 py-1 text-sm">
                  <FileIcon path={path} />
                  <span className="truncate text-ink">{basename(path)}</span>
                  <span className="truncate text-ink-faint">{dirname(path)}</span>
                  <span className="ml-auto shrink-0 text-ink-faint">{matches.length}</span>
                </div>
                {matches.map((match, index) => (
                  <button
                    key={`${match.line}-${match.column}-${index}`}
                    type="button"
                    onClick={() => reveal(match.path, match.line, match.column)}
                    className={cx(
                      'block w-full truncate px-2.5 py-0.5 pl-7 text-left font-mono text-sm',
                      'text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink',
                    )}
                  >
                    <span className="mr-2 text-ink-faint">{match.line}</span>
                    {match.preview.slice(0, match.matchStart)}
                    <mark className="rounded-sm bg-accent/30 text-ink">
                      {match.preview.slice(match.matchStart, match.matchEnd)}
                    </mark>
                    {match.preview.slice(match.matchEnd)}
                  </button>
                ))}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
