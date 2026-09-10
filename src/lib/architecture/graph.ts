import { normalizePath } from '@/lib/vfs';

/**
 * The project's shape, read out of the project.
 *
 * Every node here exists because something in the code put it there: a file
 * that imports another, a `fetch` to a URL, a Supabase client, an auth call, an
 * environment variable naming a service. Nothing is placed because a diagram
 * looks better with a box in that spot — a decorative architecture picture is
 * worse than none, because it is believed and then acted on when the code has
 * moved on.
 *
 * The consequence is that a small project produces a small graph, and a project
 * with no backend shows no backend. That is the correct output, and the panel
 * says how each node was detected so a reader can check it.
 */

export type NodeKind =
  | 'entry'
  | 'frontend'
  | 'backend'
  | 'api'
  | 'database'
  | 'auth'
  | 'service'
  | 'config'
  | 'deployment';

export interface ArchitectureNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** The file this node was found in, when it is one. */
  path?: string;
  line?: number;
  /** How this was detected, so the reader can check rather than trust. */
  evidence: string;
  /** Files inside this node, for a grouped node. */
  members?: string[];
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  /** What the relationship is: an import, a call, a configuration reference. */
  kind: 'imports' | 'calls' | 'configures';
}

export interface ArchitectureGraph {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  /** What was looked at, so an empty graph is not mistaken for a failure. */
  scannedFiles: number;
}

const IGNORED = /(^|\/)(node_modules|dist|build|coverage|\.git)\//;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/index.tsx',
  'src/index.ts',
  'index.tsx',
  'index.ts',
  'src/App.tsx',
];

/** Directories that group naturally, so a graph is readable rather than a hairball. */
const GROUPS: Array<{ prefix: string; label: string; kind: NodeKind }> = [
  { prefix: 'src/components/', label: 'Components', kind: 'frontend' },
  { prefix: 'src/pages/', label: 'Pages', kind: 'frontend' },
  { prefix: 'src/routes/', label: 'Routes', kind: 'frontend' },
  { prefix: 'src/views/', label: 'Views', kind: 'frontend' },
  { prefix: 'src/stores/', label: 'State', kind: 'frontend' },
  { prefix: 'src/hooks/', label: 'Hooks', kind: 'frontend' },
  { prefix: 'src/lib/', label: 'Library', kind: 'frontend' },
  { prefix: 'src/utils/', label: 'Utilities', kind: 'frontend' },
  { prefix: 'api/', label: 'API routes', kind: 'backend' },
  { prefix: 'server/', label: 'Server', kind: 'backend' },
  { prefix: 'functions/', label: 'Functions', kind: 'backend' },
  { prefix: 'supabase/functions/', label: 'Edge functions', kind: 'backend' },
  { prefix: 'supabase/migrations/', label: 'Migrations', kind: 'database' },
];

/** Which group a path belongs to, or null when it stands alone. */
export function groupFor(path: string): { id: string; label: string; kind: NodeKind } | null {
  // Longest prefix first, so `supabase/functions/` beats `supabase/`.
  const ordered = [...GROUPS].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const group of ordered) {
    if (path.startsWith(group.prefix)) {
      return { id: `group:${group.prefix}`, label: group.label, kind: group.kind };
    }
  }
  return null;
}

/** Resolve a relative import to a real file in the project. */
export function resolveImport(
  fromPath: string,
  specifier: string,
  files: Record<string, string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const directory = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const base = normalizePath(`${directory}/${specifier}`);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => candidate in files) ?? null;
}

/** Every import in a file, relative or bare. */
export function importsIn(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /import\s+[^'"]*from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

interface Detection {
  kind: NodeKind;
  label: string;
  evidence: string;
  pattern: RegExp;
}

/**
 * Services a project talks to, found by what the code does.
 *
 * Each is a pattern with the evidence it stands for, so the panel can say "this
 * is here because line 12 of that file creates a Supabase client" rather than
 * asking to be believed.
 */
const DETECTIONS: Detection[] = [
  {
    kind: 'database',
    label: 'Supabase (Postgres)',
    evidence: 'createClient from @supabase/supabase-js',
    pattern: /createClient\s*\(|@supabase\/supabase-js/,
  },
  {
    kind: 'auth',
    label: 'Authentication',
    evidence: 'a call to an auth API',
    // No trailing word boundary: the methods people actually call are
    // `signInWithPassword` and `signInWithOAuth`, and requiring the name to end
    // there missed both — the two most common auth calls in a Supabase project.
    pattern: /\bauth\.(signIn|signUp|signOut|getSession|getUser|onAuthStateChange|resetPassword|verifyOtp)/,
  },
  {
    kind: 'database',
    label: 'Prisma',
    evidence: 'a PrismaClient',
    pattern: /new\s+PrismaClient|@prisma\/client/,
  },
  {
    kind: 'database',
    label: 'MongoDB',
    evidence: 'a MongoDB driver or Mongoose model',
    pattern: /\bmongoose\b|\bMongoClient\b/,
  },
  {
    kind: 'service',
    label: 'Stripe',
    evidence: 'the Stripe SDK',
    pattern: /\bnew\s+Stripe\b|@stripe\//,
  },
  {
    kind: 'service',
    label: 'OpenAI',
    evidence: 'the OpenAI SDK',
    pattern: /\bnew\s+OpenAI\b|openai\.com/,
  },
  {
    kind: 'deployment',
    label: 'Vercel',
    evidence: 'a Vercel configuration or SDK reference',
    pattern: /@vercel\/|vercel\.json/,
  },
];

/** Outbound HTTP the code performs, as an API node per host. */
export function outboundHosts(content: string): string[] {
  const hosts = new Set<string>();
  for (const match of content.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)) {
    try {
      const url = new URL(match[1]);
      // localhost is a development detail, not an architecture edge.
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') continue;
      hosts.add(url.hostname);
    } catch {
      /* not a URL after all */
    }
  }
  return [...hosts];
}

export function buildGraph(files: Record<string, string>): ArchitectureGraph {
  const source = Object.entries(files).filter(
    ([path]) => !IGNORED.test(path) && SOURCE.test(path),
  );

  const nodes = new Map<string, ArchitectureNode>();
  const edges = new Map<string, ArchitectureEdge>();
  const addEdge = (from: string, to: string, kind: ArchitectureEdge['kind']) => {
    if (from === to) return;
    edges.set(`${from}->${to}:${kind}`, { from, to, kind });
  };

  // The entry point, when the project has one. It anchors the graph.
  const entry = ENTRY_CANDIDATES.find((candidate) => candidate in files);
  if (entry) {
    nodes.set('entry', {
      id: 'entry',
      label: entry,
      kind: 'entry',
      path: entry,
      evidence: 'The file the preview builds from.',
    });
  }

  /** The node a file belongs to: its group, or the entry, or itself. */
  const nodeFor = (path: string): string => {
    if (path === entry) return 'entry';
    const group = groupFor(path);
    if (!group) return `file:${path}`;
    if (!nodes.has(group.id)) {
      nodes.set(group.id, {
        id: group.id,
        label: group.label,
        kind: group.kind,
        evidence: `Files under ${group.id.replace('group:', '')}`,
        members: [],
      });
    }
    const node = nodes.get(group.id)!;
    if (node.members && !node.members.includes(path)) node.members.push(path);
    return group.id;
  };

  for (const [path] of source) {
    const id = nodeFor(path);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: path,
        kind: 'frontend',
        path,
        evidence: 'A source file in the project.',
      });
    }
  }

  for (const [path, content] of source) {
    const from = nodeFor(path);
    const lines = content.split('\n');

    for (const specifier of importsIn(content)) {
      const resolved = resolveImport(path, specifier, files);
      if (resolved) addEdge(from, nodeFor(resolved), 'imports');
    }

    for (const detection of DETECTIONS) {
      const index = lines.findIndex((line) => detection.pattern.test(line));
      if (index === -1) continue;
      const id = `svc:${detection.label}`;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: detection.label,
          kind: detection.kind,
          path,
          line: index + 1,
          evidence: detection.evidence,
        });
      }
      addEdge(from, id, 'calls');
    }

    for (const host of outboundHosts(content)) {
      const id = `api:${host}`;
      if (!nodes.has(id)) {
        const index = lines.findIndex((line) => line.includes(host));
        nodes.set(id, {
          id,
          label: host,
          kind: 'api',
          path,
          line: index === -1 ? 1 : index + 1,
          evidence: `A URL to ${host} in the source.`,
        });
      }
      addEdge(from, id, 'calls');
    }
  }

  // Configuration that shapes the deployment, when the project has it.
  for (const [path] of Object.entries(files)) {
    if (IGNORED.test(path)) continue;
    if (!/^(vercel\.json|netlify\.toml|Dockerfile|docker-compose\.ya?ml|fly\.toml)$/.test(path)) {
      continue;
    }
    nodes.set(`deploy:${path}`, {
      id: `deploy:${path}`,
      label: path,
      kind: 'deployment',
      path,
      evidence: 'A deployment configuration file in the project root.',
    });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)),
    edges: [...edges.values()],
    scannedFiles: source.length,
  };
}

/** Nodes nothing points at and which point at nothing. */
export function isolatedNodes(graph: ArchitectureGraph): ArchitectureNode[] {
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  return graph.nodes.filter((node) => !connected.has(node.id));
}

/**
 * The prompt that asks the agent about this architecture.
 *
 * Carries the graph that was derived from the project, and asks for advice
 * grounded in it. An architecture suggestion invented from a project's name is
 * the decorative-diagram problem again, one layer up.
 */
export function architecturePrompt(graph: ArchitectureGraph): string {
  const byKind = new Map<NodeKind, string[]>();
  for (const node of graph.nodes) {
    byKind.set(node.kind, [...(byKind.get(node.kind) ?? []), node.label]);
  }

  return [
    'Here is this project’s architecture, derived from its own files.',
    '',
    ...[...byKind.entries()].map(([kind, labels]) => `${kind}: ${labels.join(', ')}`),
    '',
    `${graph.edges.length} relationships between them, over ${graph.scannedFiles} source files.`,
    '',
    'Read the files this describes before answering. Say what this architecture does well, what',
    'is likely to hurt as it grows, and what you would change first — grounded in what the code',
    'actually does. If the graph is too sparse to judge, say that instead of inventing structure.',
  ].join('\n');
}
