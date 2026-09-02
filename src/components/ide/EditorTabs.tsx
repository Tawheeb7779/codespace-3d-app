import { useRef } from 'react';
import { Columns2, Pin, X } from 'lucide-react';
import { FileIcon } from '@/components/ide/FileIcon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { useContextMenu } from '@/hooks/useContextMenu';
import { splitTargetFor, useEditorStore } from '@/stores/editorStore';
import { useFileStore } from '@/stores/fileStore';
import { basename } from '@/lib/vfs';
import { cx } from '@/lib/utils';
import { useState } from 'react';

export function EditorTabs() {
  const { tabs, activePath, splitPath, setActive, closeTab, closeOthers, closeAll, togglePin, reorder, setSplit } =
    useEditorStore();
  const dirty = useFileStore((s) => s.dirty);
  const menu = useContextMenu();
  const [target, setTarget] = useState<string | null>(null);
  const dragIndex = useRef<number | null>(null);

  if (!tabs.length) return null;

  const items: MenuItem[] = target
    ? [
        { id: 'close', label: 'Close', onSelect: () => closeTab(target) },
        { id: 'close-others', label: 'Close others', onSelect: () => closeOthers(target) },
        { id: 'close-all', label: 'Close all', onSelect: closeAll },
        {
          id: 'pin',
          label: tabs.find((t) => t.path === target)?.pinned ? 'Unpin' : 'Pin',
          icon: <Pin className="h-3.5 w-3.5" />,
          separatorBefore: true,
          onSelect: () => togglePin(target),
        },
        {
          id: 'split',
          label: splitPath === target ? 'Close split view' : 'Open to the side',
          icon: <Columns2 className="h-3.5 w-3.5" />,
          onSelect: () => setSplit(splitPath === target ? null : target),
        },
      ]
    : [];

  return (
    <>
      <div
        role="tablist"
        aria-label="Open editors"
        className="scrollbar-thin flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface"
      >
        {tabs.map((tab, index) => {
          const active = tab.path === activePath;
          const isDirty = dirty.has(tab.path);
          return (
            <div
              key={tab.path}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              draggable
              onDragStart={() => (dragIndex.current = index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex.current !== null && dragIndex.current !== index) {
                  reorder(dragIndex.current, index);
                }
                dragIndex.current = null;
              }}
              onClick={() => setActive(tab.path)}
              onAuxClick={(event) => {
                // Middle click closes, as in every other editor.
                if (event.button === 1) closeTab(tab.path);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') setActive(tab.path);
                if (event.key === 'Delete' || event.key === 'Backspace') closeTab(tab.path);
              }}
              onContextMenu={(event) => {
                setTarget(tab.path);
                menu.open(event);
              }}
              className={cx(
                'group relative flex max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-2.5',
                'text-base transition-colors',
                active
                  ? 'bg-canvas text-ink'
                  : 'bg-surface text-ink-muted hover:bg-surface-raised hover:text-ink',
              )}
            >
              {active && <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-accent" />}
              <FileIcon path={tab.path} />
              <span className="truncate">{basename(tab.path)}</span>
              {tab.pinned && <Pin aria-label="Pinned" className="h-2.5 w-2.5 shrink-0 text-ink-faint" />}
              <button
                type="button"
                aria-label={`Close ${basename(tab.path)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.path);
                }}
                className={cx(
                  'ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm',
                  'hover:bg-line-strong',
                  isDirty && 'text-accent',
                )}
              >
                {isDirty ? (
                  <span
                    aria-label="Unsaved changes"
                    className="block h-1.5 w-1.5 rounded-full bg-current group-hover:hidden"
                  />
                ) : null}
                <X className={cx('h-3 w-3', isDirty && 'hidden group-hover:block')} />
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex items-center px-1.5">
          <IconButton
            label={splitPath ? 'Close split view' : 'Split editor'}
            icon={<Columns2 className="h-3.5 w-3.5" />}
            active={Boolean(splitPath)}
            onClick={() => setSplit(splitPath ? null : splitTargetFor(tabs, activePath))}
          />
        </div>
      </div>
      <Menu items={items} anchor={menu.anchor} onClose={menu.close} label="Tab actions" />
    </>
  );
}
