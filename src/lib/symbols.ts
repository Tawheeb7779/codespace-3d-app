import { monaco } from '@/lib/monaco';
import { extname } from '@/lib/vfs';

/**
 * The document outline.
 *
 * Symbols come from the TypeScript language service already running in a
 * worker for the editor — the same analysis behind completion and
 * go-to-definition — through `getNavigationTree`, which is part of that
 * worker's public surface. It is a real parse of the file.
 *
 * That choice is the whole point. A regular-expression outline looks fine on
 * the files it happens to match and silently lies about everything else, and a
 * navigation tool that lies is worse than one that admits it has nothing. So
 * languages without a TypeScript service return `null`, and the panel says the
 * outline is unavailable rather than showing an empty structure.
 */

export interface OutlineSymbol {
  id: string;
  name: string;
  kind: string;
  line: number;
  depth: number;
}

/** Languages the bundled TypeScript worker analyses. */
const TS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

export function supportsOutline(path: string): boolean {
  return TS_EXTENSIONS.has(extname(path));
}

/** The shape `getNavigationTree` returns, narrowed to what the outline needs. */
interface NavigationTree {
  text: string;
  kind: string;
  spans: { start: number; length: number }[];
  childItems?: NavigationTree[];
}

/** Structural noise: the synthetic root, and entries with nowhere to jump to. */
function isRenderable(node: NavigationTree, depth: number): boolean {
  if (depth === 0) return false;
  if (!node.text || node.text === '<global>') return false;
  return Boolean(node.spans?.length);
}

function walk(
  node: NavigationTree,
  model: monaco.editor.ITextModel,
  depth: number,
  out: OutlineSymbol[],
): void {
  if (isRenderable(node, depth)) {
    const start = node.spans[0].start;
    // The worker reports offsets; the editor navigates by line.
    const position = model.getPositionAt(start);
    out.push({
      id: `${node.kind}:${node.text}:${start}`,
      name: node.text,
      kind: node.kind,
      line: position.lineNumber,
      // Depth 1 is the file's top level, which should render flush left.
      depth: Math.max(0, depth - 1),
    });
  }
  for (const child of node.childItems ?? []) walk(child, model, depth + 1, out);
}

/**
 * Symbols for a file, or `null` when no language service can analyse it.
 *
 * `null` and `[]` mean different things and both are used: no service versus a
 * file that genuinely declares nothing.
 */
export async function outlineFor(path: string): Promise<OutlineSymbol[] | null> {
  if (!supportsOutline(path)) return null;

  const model = monaco.editor
    .getModels()
    .find((candidate) => candidate.uri.path.replace(/^\//, '') === path);
  if (!model) return null;

  try {
    const language = model.getLanguageId();
    const getWorker =
      language === 'javascript'
        ? await monaco.languages.typescript.getJavaScriptWorker()
        : await monaco.languages.typescript.getTypeScriptWorker();
    const client = (await getWorker(model.uri)) as unknown as {
      getNavigationTree?: (fileName: string) => Promise<NavigationTree | undefined>;
    };
    if (!client.getNavigationTree) return null;

    const tree = await client.getNavigationTree(model.uri.toString());
    if (!tree) return null;

    const out: OutlineSymbol[] = [];
    walk(tree, model, 0, out);
    return out;
  } catch {
    // A worker that is still starting, or a model disposed mid-flight. Absent
    // is the honest answer; an empty outline would claim the file is empty.
    return null;
  }
}
