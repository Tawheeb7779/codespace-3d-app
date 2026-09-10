/**
 * Pointing at something in the preview and finding the code that wrote it.
 *
 * **There is no source map from the running DOM back to a line.** The preview
 * runs a bundle inside an iframe sandboxed without `allow-same-origin` — a
 * security boundary this build does not weaken — and the bundle carries no
 * per-element provenance. So the honest way to answer "which line made this
 * button" is to *search the source* for what the element shows: its id, its
 * class string, its text.
 *
 * That is a heuristic, and this module never pretends otherwise. Every
 * candidate says what it matched on and how confident that makes it, an
 * ambiguous match is reported as ambiguous rather than resolved by picking the
 * first, and when nothing matches the reason is named — because an element whose
 * text is computed at runtime genuinely has no literal to find, and "not found"
 * without that explanation reads as a bug.
 *
 * Nothing here edits anything on its own. `planTextEdit` and `planClassEdit`
 * return the new file content for the caller to write through the ordinary file
 * store, or a problem describing why the edit cannot be made safely. An edit
 * that is not certain is refused, because a wrong replacement in source is
 * expensive and silent.
 */

/** What the preview reported about the element that was clicked. */
export interface Selection {
  tag: string;
  id: string | null;
  classes: string[];
  /** The element's own text, trimmed and capped by the bridge. */
  text: string | null;
  /** Where it sits in the document, for the panel to show. */
  path: string;
}

export type Confidence = 'exact' | 'likely' | 'weak';

export interface Candidate {
  path: string;
  /** 1-based, as an editor counts. */
  line: number;
  /** The line itself, for the panel to show before anything is changed. */
  source: string;
  confidence: Confidence;
  /** What the match was made on, in the order it was found. */
  matchedOn: string[];
}

export interface LocateResult {
  candidates: Candidate[];
  /** Said when there is nothing to show, or when what is shown is uncertain. */
  note: string | null;
}

/** Files that could plausibly contain markup. */
const SEARCHABLE = /\.(tsx|jsx|ts|js|mjs|html|vue|svelte|astro)$/;

/** Files that are output, not source — matching in them helps nobody. */
const IGNORED = /(^|\/)(node_modules|dist|build|\.next|coverage)\//;

/** Text short enough to be a label rather than a paragraph of prose. */
const MAX_TEXT_MATCH = 120;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The class attribute as it appears in source, if this line has one.
 *
 * Both spellings, because a project may hold JSX and plain HTML at once.
 */
export function classAttribute(line: string): { quote: string; value: string; index: number } | null {
  const match = /\b(?:className|class)\s*=\s*(["'])([^"']*)\1/.exec(line);
  if (!match) return null;
  return { quote: match[1], value: match[2], index: match.index };
}

/**
 * Find the lines that could have produced this element.
 *
 * Ranked, never resolved: two lines that match equally well are both returned,
 * and the note says the choice is the reader's.
 */
export function locateElement(
  files: Record<string, string>,
  selection: Selection,
): LocateResult {
  const classString = selection.classes.join(' ');
  const text =
    selection.text && selection.text.length <= MAX_TEXT_MATCH ? selection.text.trim() : null;

  if (!selection.id && !classString && !text) {
    return {
      candidates: [],
      note: `This <${selection.tag}> has no id, no class and no text of its own, so there is nothing to search the source for. Select a child element, or one with a class on it.`,
    };
  }

  const candidates: Candidate[] = [];

  for (const [path, content] of Object.entries(files)) {
    if (!SEARCHABLE.test(path) || IGNORED.test(path)) continue;
    if (typeof content !== 'string') continue;

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matchedOn: string[] = [];

      if (selection.id && new RegExp(`\\bid\\s*=\\s*["']${escapeRegExp(selection.id)}["']`).test(line)) {
        matchedOn.push('id');
      }

      const attribute = classAttribute(line);
      if (classString && attribute && attribute.value.trim() === classString) {
        matchedOn.push('class');
      }

      const tagOnLine = new RegExp(`<${escapeRegExp(selection.tag)}[\\s/>]`, 'i').test(line);
      if (text && line.includes(text)) matchedOn.push('text');
      if (tagOnLine && matchedOn.length) matchedOn.push('tag');

      if (!matchedOn.length) continue;

      candidates.push({
        path,
        line: index + 1,
        source: line,
        confidence: rank(matchedOn),
        matchedOn,
      });
    }
  }

  candidates.sort((a, b) => order(b.confidence) - order(a.confidence) || a.path.localeCompare(b.path));

  if (!candidates.length) {
    return {
      candidates: [],
      note: `Nothing in the source matches this element. Its text or classes are probably built at runtime — from a variable, a template string, or a component that takes them as props — and there is no literal to find. The preview runs a bundle, so there is no source map back to a line.`,
    };
  }

  const best = candidates[0].confidence;
  const tied = candidates.filter((candidate) => candidate.confidence === best);
  const note =
    tied.length > 1
      ? `${tied.length} lines match this element equally well. Pick the right one — this is a text search, not a source map, and it cannot tell them apart.`
      : best === 'weak'
        ? 'This is a weak match: only part of the element could be found in the source. Check the line before editing it.'
        : null;

  return { candidates: candidates.slice(0, 20), note };
}

function rank(matchedOn: string[]): Confidence {
  if (matchedOn.includes('id')) return 'exact';
  if (matchedOn.includes('class') && matchedOn.includes('tag')) return 'likely';
  if (matchedOn.includes('class') || (matchedOn.includes('text') && matchedOn.includes('tag'))) {
    return 'likely';
  }
  return 'weak';
}

function order(confidence: Confidence): number {
  return confidence === 'exact' ? 3 : confidence === 'likely' ? 2 : 1;
}

export type EditPlan = { ok: true; next: string; before: string; after: string } | { ok: false; problem: string };

function lineAt(content: string, line: number): { lines: string[]; index: number } | null {
  const lines = content.split('\n');
  const index = line - 1;
  if (index < 0 || index >= lines.length) return null;
  return { lines, index };
}

/**
 * Replace an element's text on one line.
 *
 * Refused when the old text is not on that line, or appears on it more than
 * once: replacing the wrong one of two identical labels is a silent wrong edit,
 * and the panel would report it as a success.
 */
export function planTextEdit(
  content: string,
  line: number,
  oldText: string,
  newText: string,
): EditPlan {
  const located = lineAt(content, line);
  if (!located) return { ok: false, problem: 'That line is no longer in the file.' };

  const { lines, index } = located;
  const target = lines[index];
  const trimmed = oldText.trim();

  if (!trimmed) return { ok: false, problem: 'The element has no literal text to replace.' };
  if (!newText.trim()) return { ok: false, problem: 'The replacement text is empty.' };

  const occurrences = target.split(trimmed).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      problem: 'That text is not on this line any more. Re-select the element in the preview.',
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      problem: `"${trimmed}" appears ${occurrences} times on this line, so replacing it would be a guess. Edit the file directly.`,
    };
  }

  const after = target.replace(trimmed, newText);
  lines[index] = after;
  return { ok: true, next: lines.join('\n'), before: target, after };
}

/**
 * Replace the class attribute on one line.
 *
 * Refused when the line's class attribute is not the one that was selected —
 * the file has moved on, and writing anyway would overwrite somebody's change.
 */
export function planClassEdit(
  content: string,
  line: number,
  oldClasses: string,
  newClasses: string,
): EditPlan {
  const located = lineAt(content, line);
  if (!located) return { ok: false, problem: 'That line is no longer in the file.' };

  const { lines, index } = located;
  const target = lines[index];
  const attribute = classAttribute(target);

  if (!attribute) {
    return { ok: false, problem: 'This line has no class attribute to change.' };
  }
  if (attribute.value.trim() !== oldClasses.trim()) {
    return {
      ok: false,
      problem: `This line's classes are now "${attribute.value}", not what was selected. Re-select the element in the preview.`,
    };
  }
  if (/[<>"']/.test(newClasses)) {
    return { ok: false, problem: 'Class names cannot contain quotes or angle brackets.' };
  }

  const before = target;
  const after =
    target.slice(0, attribute.index) +
    target
      .slice(attribute.index)
      .replace(
        `=${attribute.quote}${attribute.value}${attribute.quote}`,
        `=${attribute.quote}${newClasses.trim()}${attribute.quote}`,
      );
  lines[index] = after;
  return { ok: true, next: lines.join('\n'), before, after };
}

/**
 * Read a selection off an untrusted `postMessage` from the preview.
 *
 * The preview runs the user's own bundle inside a sandbox, so what comes back
 * is data from a foreign document: every field is checked and capped here so a
 * malformed or hostile message cannot reach the rest of the panel as anything
 * but short strings.
 */
export function readSelection(data: unknown): Selection | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const tag = typeof raw.tag === 'string' ? raw.tag.toLowerCase().slice(0, 40) : '';
  if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;

  const classes = Array.isArray(raw.classes)
    ? raw.classes
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.slice(0, 80))
        .slice(0, 40)
    : [];

  return {
    tag,
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : null,
    classes,
    text: typeof raw.text === 'string' && raw.text.trim() ? raw.text.slice(0, 200) : null,
    path: typeof raw.path === 'string' ? raw.path.slice(0, 300) : tag,
  };
}
