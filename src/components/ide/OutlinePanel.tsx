import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { EmptyState, Spinner } from '@/components/ui/Primitives';
import { useEditorStore } from '@/stores/editorStore';
import { useFileStore } from '@/stores/fileStore';
import { outlineFor, supportsOutline, type OutlineSymbol } from '@/lib/symbols';
import { cx } from '@/lib/utils';

/**
 * The symbols in the open file.
 *
 * Three states, kept distinct because they mean different things: a language
 * the editor cannot analyse, a file that genuinely declares nothing, and a
 * real list. Collapsing the first two into one empty list would quietly claim
 * every CSS file has no structure.
 */
export function OutlinePanel() {
  const activePath = useEditorStore((s) => s.activePath);
  const reveal = useEditorStore((s) => s.revealLocation);
  const cursorLine = useEditorStore((s) => s.cursor.line);
  // The file content, so the outline refreshes as the file is edited.
  const content = useFileStore((s) => (activePath ? s.files[activePath] : undefined));

  const [symbols, setSymbols] = useState<OutlineSymbol[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activePath || !supportsOutline(activePath)) {
      setSymbols(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Debounced: the language service reparses on every keystroke otherwise,
    // and an outline that flickers is harder to use than one a beat behind.
    const timer = setTimeout(() => {
      void outlineFor(activePath).then((result) => {
        if (cancelled) return;
        setSymbols(result);
        setLoading(false);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activePath, content]);

  /** The innermost symbol the caret sits in, for the active highlight. */
  const activeIndex = useMemo(() => {
    if (!symbols?.length) return -1;
    let best = -1;
    for (let index = 0; index < symbols.length; index++) {
      if (symbols[index].line <= cursorLine) best = index;
      else break;
    }
    return best;
  }, [symbols, cursorLine]);

  if (!activePath) {
    // Deliberately not "No file open": the editor already says that, and two
    // panels repeating one sentence reads like a bug.
    return <EmptyState title="Nothing to outline" description="Open a file to see its symbols." />;
  }

  if (!supportsOutline(activePath)) {
    return (
      <div className="p-2.5">
        <p className="flex items-start gap-1.5 text-sm text-ink-faint">
          <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
          Outlines come from the TypeScript language service, so they are available for
          JavaScript and TypeScript files. This file is not analysed.
        </p>
      </div>
    );
  }

  if (loading && !symbols) {
    return (
      <div className="flex items-center gap-2 p-2.5 text-sm text-ink-faint">
        <Spinner className="h-3.5 w-3.5" /> Reading symbols…
      </div>
    );
  }

  if (symbols === null) {
    return (
      <EmptyState
        title="Outline unavailable"
        description="The language service could not analyse this file."
      />
    );
  }

  if (!symbols.length) {
    return (
      <EmptyState title="No symbols" description="This file does not declare anything yet." />
    );
  }

  return (
    <ul role="tree" aria-label="Document symbols" className="scrollbar-thin h-full overflow-y-auto py-1">
      {symbols.map((symbol, index) => (
        <li key={`${symbol.id}-${index}`} role="none">
          <button
            type="button"
            role="treeitem"
            aria-selected={index === activeIndex}
            onClick={() => reveal(activePath, symbol.line, 1)}
            style={{ paddingLeft: symbol.depth * 12 + 10 }}
            className={cx(
              'flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-base transition-colors',
              index === activeIndex
                ? 'bg-accent-soft text-ink'
                : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
            )}
          >
            <span className="shrink-0 font-mono text-xs text-ink-faint">{symbol.kind}</span>
            <span className="min-w-0 flex-1 truncate">{symbol.name}</span>
            <span className="shrink-0 text-sm text-ink-faint">{symbol.line}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
