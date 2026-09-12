import {
  Activity,
  Blocks,
  Bot,
  Boxes,
  Database,
  Files,
  Gauge,
  GitBranch,
  Hammer,
  HardDrive,
  HeartPulse,
  History,
  Layers,
  LayoutList,
  ListChecks,
  MessageSquare,
  MousePointerSquareDashed,
  Package,
  Search,
  Send,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { SidebarPanel } from '@/stores/uiStore';

/**
 * The workspace's side panels, described once.
 *
 * There were four lists of these and they had to be kept in agreement by hand:
 * the `SidebarPanel` union, the activity bar's icons and labels, the switch
 * that picks a component, and the command palette's entries. Adding a panel
 * meant remembering all four, and the drift that predicts had already
 * happened — `explorer` was in the union and on the rail with no case in the
 * switch, reaching its panel only because it fell through to the default.
 *
 * Worse was what the palette knew. Eight of the twenty-three panels had a
 * command; the other fifteen — the database studio, the API client, the
 * profiler, the security centre, the architecture view — could be reached
 * only by recognising one of twenty-three identical 16px glyphs in a 44px
 * rail. A feature nobody can find is not a feature, and the palette is where
 * people look.
 *
 * So this is a `Record` keyed by the union rather than an array: adding a
 * panel to `SidebarPanel` fails the build until it is described here, and
 * everything downstream is derived rather than repeated.
 *
 * Deliberately data only — no components. The route owns the mapping from id
 * to element, because that is where the imports belong and where code
 * splitting can see them.
 */

/**
 * How prominent a panel is, which is the only hierarchy twenty-three flat
 * icons were missing.
 *
 * `primary` is the work itself: the files, finding things, the changes, the
 * running of it, and the assistant. `secondary` is about the project rather
 * than the code. `advanced` is the specialist tooling — real, and not what a
 * new user should have to wade through to reach the file tree.
 */
export type PanelGroup = 'primary' | 'secondary' | 'advanced';

export const GROUP_LABEL: Record<PanelGroup, string> = {
  primary: 'Workspace',
  secondary: 'Project',
  advanced: 'Tools',
};

export interface PanelInfo {
  label: string;
  icon: LucideIcon;
  group: PanelGroup;
  /**
   * Extra words this panel should be findable by.
   *
   * Someone looking for the profiler types "profiler", not "Performance", and
   * a search that only matches the visible label makes the person guess the
   * name the product happened to choose.
   */
  keywords: string;
  /** The keymap binding that focuses this panel, where one exists. */
  binding?: string;
}

export const WORKSPACE_PANELS: Record<SidebarPanel, PanelInfo> = {
  explorer: {
    label: 'Explorer',
    icon: Files,
    group: 'primary',
    keywords: 'files tree folders',
    binding: 'explorer',
  },
  search: {
    label: 'Search',
    icon: Search,
    group: 'primary',
    keywords: 'find replace grep across files',
    binding: 'search',
  },
  git: {
    label: 'Source control',
    icon: GitBranch,
    group: 'primary',
    keywords: 'git commit branch diff changes staging',
    binding: 'sourceControl',
  },
  builder: {
    label: 'Build',
    icon: Hammer,
    group: 'primary',
    keywords: 'compile bundle output',
  },
  assistant: {
    label: 'Assistant',
    icon: Bot,
    group: 'primary',
    keywords: 'ai chat agent model llm',
    binding: 'assistant',
  },

  project: { label: 'Project', icon: LayoutList, group: 'secondary', keywords: 'overview readme' },
  tasks: { label: 'Tasks', icon: ListChecks, group: 'secondary', keywords: 'run scripts jobs' },
  packages: {
    label: 'Packages',
    icon: Package,
    group: 'secondary',
    keywords: 'npm dependencies install modules',
  },
  comments: {
    label: 'Comments',
    icon: MessageSquare,
    group: 'secondary',
    keywords: 'review threads mentions discussion',
  },
  members: {
    label: 'Members',
    icon: Users,
    group: 'secondary',
    keywords: 'collaborators team permissions roles sharing',
  },
  timeline: {
    label: 'Timeline',
    icon: History,
    group: 'secondary',
    keywords: 'snapshots history time travel restore',
  },
  activity: {
    label: 'Activity',
    icon: Activity,
    group: 'secondary',
    keywords: 'events log recent',
  },

  database: {
    label: 'Database',
    icon: Database,
    group: 'advanced',
    keywords: 'sql query table postgres studio',
  },
  api: {
    label: 'API',
    icon: Send,
    group: 'advanced',
    keywords: 'http request rest client endpoint',
  },
  environments: {
    label: 'Environments',
    icon: Layers,
    group: 'advanced',
    keywords: 'env variables secrets configuration',
  },
  security: {
    label: 'Security',
    icon: ShieldCheck,
    group: 'advanced',
    keywords: 'scan vulnerabilities secrets audit',
  },
  performance: {
    label: 'Performance',
    icon: Gauge,
    group: 'advanced',
    keywords: 'profiler bundle size build time metrics',
  },
  architecture: {
    label: 'Architecture',
    icon: Boxes,
    group: 'advanced',
    keywords: 'dependencies graph structure modules',
  },
  observability: {
    label: 'Observability',
    icon: Activity,
    group: 'advanced',
    keywords: 'traces timeline telemetry monitoring',
  },
  health: {
    label: 'Project health',
    icon: HeartPulse,
    group: 'advanced',
    keywords: 'checks status diagnostics report',
  },
  extensions: {
    label: 'Extensions',
    icon: Blocks,
    group: 'advanced',
    keywords: 'plugins addons marketplace',
  },
  uibuilder: {
    label: 'UI builder',
    icon: MousePointerSquareDashed,
    group: 'advanced',
    keywords: 'design layout components visual',
  },
  linuxfiles: {
    label: 'Linux files',
    icon: HardDrive,
    group: 'advanced',
    keywords: 'container workspace remote filesystem',
  },
};

/** The order the rail and the palette both present, grouped. */
export const PANEL_ORDER: PanelGroup[] = ['primary', 'secondary', 'advanced'];

export function panelsInGroup(group: PanelGroup): Array<{ id: SidebarPanel; info: PanelInfo }> {
  return (Object.keys(WORKSPACE_PANELS) as SidebarPanel[])
    .filter((id) => WORKSPACE_PANELS[id].group === group)
    .map((id) => ({ id, info: WORKSPACE_PANELS[id] }));
}

/** Every panel, grouped, in the order the product presents them. */
export function allPanels(): Array<{ id: SidebarPanel; info: PanelInfo }> {
  return PANEL_ORDER.flatMap(panelsInGroup);
}
