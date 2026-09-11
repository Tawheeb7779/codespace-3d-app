/**
 * The parts of the IDE the agent may drive, named as a closed set.
 *
 * "Open src/App.tsx" should open the file, not produce a paragraph about how to
 * open it. But an agent that can move the interface is an agent that can move
 * somebody's attention away from what it is doing, so the set is small,
 * enumerated, and holds nothing that destroys or hides work: it opens files and
 * panels, and that is all. Closing a panel, closing a tab and switching project
 * are deliberately absent — they take something away from the person watching.
 *
 * Every target is validated here rather than at the call site, so a name the
 * model invented is refused with the list of real ones instead of silently
 * doing nothing. A navigation that quietly no-ops is worse than a refusal: the
 * agent reports it as done and the person sees an unchanged screen.
 */

import type { SidebarPanel } from '@/stores/uiStore';

/**
 * Panels the agent may bring forward, with what each is for.
 *
 * The description is what the model reads, so it is written for choosing
 * between them rather than as a UI label.
 */
export const AGENT_PANELS: Record<string, { panel: SidebarPanel; description: string }> = {
  explorer: { panel: 'explorer', description: 'the project file tree' },
  search: { panel: 'search', description: 'search across the project' },
  git: { panel: 'git', description: 'source control: changes, history, branches' },
  assistant: { panel: 'assistant', description: 'this assistant' },
  tasks: { panel: 'tasks', description: 'the autonomous task list' },
  packages: { panel: 'packages', description: 'dependencies and upgrades' },
  security: { panel: 'security', description: 'the security centre' },
  health: { panel: 'health', description: 'project health and analytics' },
  api: { panel: 'api', description: 'the API studio' },
  environments: { panel: 'environments', description: 'environment manager and secrets' },
  performance: { panel: 'performance', description: 'the performance profiler' },
  architecture: { panel: 'architecture', description: 'the architecture graph' },
  timeline: { panel: 'timeline', description: 'snapshots and time travel' },
  database: { panel: 'database', description: 'the database studio' },
  observability: { panel: 'observability', description: 'logs and traces' },
};

/** Panel names the agent may pass, for the tool schema and the refusal text. */
export const AGENT_PANEL_NAMES = Object.keys(AGENT_PANELS);

export function panelFor(name: string): SidebarPanel | null {
  return AGENT_PANELS[name]?.panel ?? null;
}

/**
 * What the IDE lets the agent do, supplied by the store that owns the UI.
 *
 * Optional everywhere it is used: a headless caller — every test harness, and
 * the builder running without a workspace — has no interface to drive, and is
 * told so rather than handed a tool that pretends to have opened something.
 */
export interface IdeActions {
  /** Open a file in the editor, optionally putting the caret on a line. */
  openFile(path: string, line?: number): void;
  /** Bring a sidebar panel forward. */
  openPanel(panel: SidebarPanel): void;
  /** Show the preview, building it if it is not already running. */
  openPreview(): void;
  /** Show the Problems list in the bottom panel. */
  openProblems(): void;
}

/** A line number the agent supplied, or undefined when it gave nothing usable. */
export function readLine(value: unknown): number | undefined {
  const line = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(line) || line < 1) return undefined;
  return Math.floor(line);
}
