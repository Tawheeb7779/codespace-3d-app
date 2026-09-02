import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { FileIcon } from '@/components/ide/FileIcon';
import { rankPaths } from '@/lib/search';
import { cx } from '@/lib/utils';
import { formatChord } from '@/hooks/useKeyboardShortcuts';
import { basename, dirname } from '@/lib/vfs';

export interface Command {
  id: string;
  label: string;
  group: string;
  keys?: string;
  disabled?: boolean;
  run: () => void;
}

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  files: string[];
  onOpenFile: (path: string) => void;
  /** Start in file mode (quick open) rather than command mode. */
  fileMode?: boolean;
}

/**
 * One overlay serving both the command palette and quick-open. Typing `>`
 * switches to commands, anything else searches files, matching the muscle
 * memory people bring from other editors.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  files,
  onOpenFile,
  fileMode = false,
}: PaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery(fileMode ? '' : '>');
      setIndex(0);
    }
  }, [open, fileMode]);

  const commandMode = query.startsWith('>');
  const term = commandMode ? query.slice(1).trim() : query.trim();

  const results = useMemo(() => {
    if (commandMode) {
      const needle = term.toLowerCase();
      return commands
        .filter(
          (command) =>
            !needle ||
            command.label.toLowerCase().includes(needle) ||
            command.group.toLowerCase().includes(needle),
        )
        .map((command) => ({ kind: 'command' as const, command }));
    }
    return rankPaths(files, term, 50).map((path) => ({ kind: 'file' as const, path }));
  }, [commandMode, term, commands, files]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    const active = listRef.current?.children[index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open || typeof document === 'undefined') return null;

  const choose = (position: number) => {
    const result = results[position];
    if (!result) return;
    onClose();
    if (result.kind === 'command') {
      if (result.command.disabled) return;
      result.command.run();
    } else {
      onOpenFile(result.path);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center p-4">
      <div className="fixed inset-0 animate-fade-in bg-black/50" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={commandMode ? 'Command palette' : 'Open file'}
        className="relative mt-[10vh] w-full max-w-xl animate-scale-in overflow-hidden rounded-lg border border-line bg-surface-overlay shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <input
            autoFocus
            aria-label={commandMode ? 'Search commands' : 'Search files'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((i) => (i + 1) % Math.max(1, results.length));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((i) => (i - 1 + results.length) % Math.max(1, results.length));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(index);
              }
            }}
            placeholder={commandMode ? 'Type a command…' : 'Search files by name…'}
            className="h-11 w-full bg-transparent text-md text-ink placeholder:text-ink-faint focus:outline-none"
          />
        </div>

        <ul ref={listRef} role="listbox" className="scrollbar-thin max-h-80 overflow-y-auto py-1">
          {!results.length && (
            <li className="px-3 py-6 text-center text-base text-ink-faint">
              {commandMode ? 'No matching commands' : 'No matching files'}
            </li>
          )}
          {results.map((result, position) => {
            const selected = position === index;
            if (result.kind === 'command') {
              return (
                <li
                  key={result.command.id}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => choose(position)}
                  className={cx(
                    'flex cursor-pointer items-center gap-3 px-3 py-1.5 text-base',
                    result.command.disabled && 'opacity-40',
                    selected ? 'bg-accent-soft text-ink' : 'text-ink-muted',
                  )}
                >
                  <span className="w-20 shrink-0 truncate text-sm text-ink-faint">
                    {result.command.group}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{result.command.label}</span>
                  {result.command.keys && (
                    <span className="shrink-0 font-mono text-sm text-ink-faint">
                      {formatChord(result.command.keys)}
                    </span>
                  )}
                </li>
              );
            }
            return (
              <li
                key={result.path}
                role="option"
                aria-selected={selected}
                onMouseEnter={() => setIndex(position)}
                onClick={() => choose(position)}
                className={cx(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-base',
                  selected ? 'bg-accent-soft text-ink' : 'text-ink-muted',
                )}
              >
                <FileIcon path={result.path} />
                <span className="truncate">{basename(result.path)}</span>
                <span className="truncate text-sm text-ink-faint">{dirname(result.path)}</span>
              </li>
            );
          })}
        </ul>

        <p className="border-t border-line px-3 py-1.5 text-sm text-ink-faint">
          {commandMode
            ? 'Remove the > to search files instead.'
            : 'Type > to run a command.'}
        </p>
      </div>
    </div>,
    document.body,
  );
}
