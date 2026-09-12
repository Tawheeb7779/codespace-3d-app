import { Fragment } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { useUIStore } from '@/stores/uiStore';
import { useGitStore } from '@/stores/gitStore';
import { GROUP_LABEL, PANEL_ORDER, panelsInGroup } from '@/lib/workspacePanels';
import { cx } from '@/lib/utils';

/**
 * The rail of workspace panels.
 *
 * Two things about it are deliberate and were not before.
 *
 * It is grouped. Twenty-three icons in one undifferentiated column gave a new
 * user no way to tell the file tree from the database studio, and the rail is
 * the first thing they look at. The groups come from `workspacePanels`, so the
 * rail and the command palette present the same hierarchy rather than two
 * opinions of it.
 *
 * It scrolls, and its buttons do not shrink. They used to: the column is a
 * flex container and twenty-three items do not fit a short window, so the
 * browser compressed them. Measured in Chromium at 1440x720 — an ordinary
 * laptop — every button came out 23.8px tall, and at 640px 20.3px, under the
 * 24x24 CSS px minimum this project holds itself to. `shrink-0` keeps them the
 * size they are drawn and the overflow becomes a scroll, which is the honest
 * way to run out of room.
 */
export function ActivityBar() {
  const sidebarPanel = useUIStore((s) => s.sidebarPanel);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);
  const changes = useGitStore((s) => s.status.staged.length + s.status.unstaged.length);

  return (
    <nav
      aria-label="Workspace panels"
      className="scrollbar-thin flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden border-r border-line bg-surface py-2"
    >
      {PANEL_ORDER.map((group, groupIndex) => (
        <Fragment key={group}>
          {groupIndex > 0 && (
            <span aria-hidden className="my-1 h-px w-5 shrink-0 rounded-full bg-line" />
          )}
          <ul aria-label={GROUP_LABEL[group]} className="flex flex-col items-center gap-1">
            {panelsInGroup(group).map(({ id, info }) => {
              const active = sidebarOpen && sidebarPanel === id;
              const Icon = info.icon;
              return (
                <li key={id}>
                  <Tooltip content={info.label} side="right">
                    <button
                      type="button"
                      aria-label={info.label}
                      aria-pressed={active}
                      onClick={() => setSidebarPanel(id)}
                      className={cx(
                        'relative flex h-8 w-8 shrink-0 items-center justify-center rounded transition-colors',
                        active ? 'text-ink' : 'text-ink-faint hover:text-ink',
                      )}
                    >
                      {active && (
                        <span
                          aria-hidden
                          className="absolute -left-2 h-5 w-0.5 rounded-full bg-accent"
                        />
                      )}
                      <Icon className="h-4 w-4" />
                      {id === 'git' && changes > 0 && (
                        <span
                          aria-hidden
                          className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-accent-ink"
                        >
                          {changes > 99 ? '99' : changes}
                        </span>
                      )}
                    </button>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </Fragment>
      ))}
    </nav>
  );
}
