import { useMemo, useState } from 'react';
import {
  Boxes,
  Cloud,
  Database,
  Globe,
  KeyRound,
  Layers,
  RefreshCw,
  Server,
  Sparkles,
} from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useAiStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores/uiStore';
import {
  architecturePrompt,
  buildGraph,
  isolatedNodes,
  type ArchitectureNode,
  type NodeKind,
} from '@/lib/architecture/graph';
import { cx, formatTimeAgo } from '@/lib/utils';

/**
 * This project's shape, derived from this project's files.
 *
 * Every box exists because something in the code put it there — an import, a
 * client constructor, a URL, a deployment file — and each says how it was
 * found, so a reader can check it against the source rather than believe the
 * picture. A decorative architecture diagram is worse than none: it is trusted,
 * and then acted on after the code has moved past it.
 *
 * A small project therefore draws a small graph, and a project with no backend
 * shows no backend. That is the right answer, not a rendering failure, and the
 * empty state says which.
 */

const KIND_ICON: Record<NodeKind, typeof Boxes> = {
  entry: Boxes,
  frontend: Layers,
  backend: Server,
  api: Globe,
  database: Database,
  auth: KeyRound,
  service: Cloud,
  config: Layers,
  deployment: Cloud,
};

const KIND_LABEL: Record<NodeKind, string> = {
  entry: 'Entry point',
  frontend: 'Frontend',
  backend: 'Backend',
  api: 'External APIs',
  database: 'Data',
  auth: 'Authentication',
  service: 'Services',
  config: 'Configuration',
  deployment: 'Deployment',
};

const KIND_TONE: Record<NodeKind, string> = {
  entry: 'border-accent text-accent',
  frontend: 'border-line-strong text-ink',
  backend: 'border-line-strong text-ink',
  api: 'border-caution/50 text-caution',
  database: 'border-positive/50 text-positive',
  auth: 'border-caution/50 text-caution',
  service: 'border-line-strong text-ink-muted',
  config: 'border-line text-ink-muted',
  deployment: 'border-line-strong text-ink-muted',
};

const ORDER: NodeKind[] = [
  'entry',
  'frontend',
  'backend',
  'api',
  'database',
  'auth',
  'service',
  'deployment',
  'config',
];

export function ArchitecturePanel() {
  const reveal = useEditorStore((s) => s.revealLocation);
  const send = useAiStore((s) => s.send);
  const running = useAiStore((s) => s.running);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);

  /*
   * Derived on demand, over a snapshot.
   *
   * Walking every source file for imports on each keystroke would make typing
   * slower to keep a diagram current that nobody is watching while they type.
   */
  const [graph, setGraph] = useState(() => buildGraph(useFileStore.getState().files));
  const [builtAt, setBuiltAt] = useState(() => Date.now());
  const [selected, setSelected] = useState<ArchitectureNode | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<NodeKind, ArchitectureNode[]>();
    for (const node of graph.nodes) {
      map.set(node.kind, [...(map.get(node.kind) ?? []), node]);
    }
    return ORDER.filter((kind) => map.has(kind)).map((kind) => ({
      kind,
      nodes: map.get(kind)!,
    }));
  }, [graph]);

  const isolated = useMemo(() => isolatedNodes(graph), [graph]);

  const edgesFor = (node: ArchitectureNode) => ({
    out: graph.edges.filter((edge) => edge.from === node.id),
    in: graph.edges.filter((edge) => edge.to === node.id),
  });

  const labelOf = (id: string) => graph.nodes.find((node) => node.id === id)?.label ?? id;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Architecture"
        actions={
          <IconButton
            label="Derive again"
            size="xs"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => {
              setGraph(buildGraph(useFileStore.getState().files));
              setBuiltAt(Date.now());
              setSelected(null);
            }}
          />
        }
      />

      <div className="shrink-0 border-b border-line px-2.5 py-1.5">
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink-faint">
          <span>
            {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'}, {graph.edges.length}{' '}
            relationship{graph.edges.length === 1 ? '' : 's'}, from {graph.scannedFiles} source{' '}
            file{graph.scannedFiles === 1 ? '' : 's'}.
          </span>
          <span>Derived {formatTimeAgo(builtAt)}.</span>
        </p>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!graph.nodes.length ? (
          <EmptyState
            icon={<Boxes className="h-4 w-4" />}
            title="Nothing to draw yet"
            description={
              graph.scannedFiles
                ? 'The source files here import nothing and reach no service, so there are no relationships to show.'
                : 'This project has no source files yet.'
            }
          />
        ) : (
          grouped.map((group) => {
            const Icon = KIND_ICON[group.kind];
            return (
              <section key={group.kind} className="border-b border-line px-2.5 py-2">
                <p className="panel-label flex items-center gap-1.5">
                  <Icon aria-hidden className="h-3 w-3" />
                  {KIND_LABEL[group.kind]}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.nodes.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      aria-pressed={selected?.id === node.id}
                      onClick={() => setSelected(selected?.id === node.id ? null : node)}
                      className={cx(
                        'tap-target rounded-[6px] border px-2 py-1 text-sm transition-colors',
                        KIND_TONE[node.kind],
                        selected?.id === node.id ? 'bg-accent-soft' : 'hover:bg-surface-raised',
                      )}
                    >
                      {node.label}
                      {node.members && node.members.length > 0 && (
                        <span className="ml-1 tabular-nums text-ink-faint">
                          {node.members.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            );
          })
        )}

        {selected && (
          <section className="border-b border-line bg-surface-sunken px-2.5 py-2">
            <p className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-base text-ink">{selected.label}</span>
              <Badge>{KIND_LABEL[selected.kind]}</Badge>
            </p>
            {/* How it was found, so the box can be checked rather than trusted. */}
            <p className="mt-0.5 text-sm text-ink-faint">
              <span>Detected from: {selected.evidence}</span>
            </p>

            {selected.path && (
              <Button
                size="xs"
                className="mt-1.5"
                onClick={() => reveal(selected.path!, selected.line ?? 1, 1)}
              >
                Open {selected.path}
                {selected.line ? `:${selected.line}` : ''}
              </Button>
            )}

            {selected.members && selected.members.length > 0 && (
              <div className="mt-1.5">
                <p className="panel-label">Files</p>
                {selected.members.slice(0, 12).map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => reveal(path, 1, 1)}
                    className="block w-full truncate text-left font-mono text-sm text-ink-faint hover:text-ink"
                  >
                    {path}
                  </button>
                ))}
                {selected.members.length > 12 && (
                  <p className="text-sm text-ink-faint">
                    <span>and {selected.members.length - 12} more.</span>
                  </p>
                )}
              </div>
            )}

            {(() => {
              const { out, in: incoming } = edgesFor(selected);
              return (
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  <div>
                    <p className="panel-label">Depends on</p>
                    {out.length ? (
                      out.slice(0, 8).map((edge) => (
                        <p key={`${edge.to}-${edge.kind}`} className="truncate text-sm text-ink-muted">
                          {labelOf(edge.to)}{' '}
                          <span className="text-ink-faint">({edge.kind})</span>
                        </p>
                      ))
                    ) : (
                      <p className="text-sm text-ink-faint">
                        <span>Nothing.</span>
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="panel-label">Used by</p>
                    {incoming.length ? (
                      incoming.slice(0, 8).map((edge) => (
                        <p key={`${edge.from}-${edge.kind}`} className="truncate text-sm text-ink-muted">
                          {labelOf(edge.from)}
                        </p>
                      ))
                    ) : (
                      <p className="text-sm text-ink-faint">
                        <span>Nothing.</span>
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
          </section>
        )}

        {isolated.length > 0 && (
          <section className="border-b border-line px-2.5 py-2">
            <p className="panel-label">Not connected</p>
            <p className="mt-0.5 text-sm text-ink-faint">
              <span>
                {isolated.map((node) => node.label).join(', ')} — nothing imports these and they
                import nothing. That may be intentional, or they may be unused.
              </span>
            </p>
          </section>
        )}

        {graph.nodes.length > 0 && (
          <div className="p-2.5">
            <Button
              size="xs"
              disabled={running}
              leading={<Sparkles className="h-3 w-3" />}
              onClick={() => {
                // The ordinary agent, given the graph derived from the project
                // and told to read the files rather than invent structure.
                setSidebarPanel('assistant');
                void send(architecturePrompt(graph));
              }}
            >
              Ask the assistant about this architecture
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
